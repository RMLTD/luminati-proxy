// LICENSE_CODE ZON ISC
'use strict'; /*jslint node:true, esnext:true*/
const _ = require('lodash');
const events = require('events');
const http = require('http');
const https = require('https');
const dns = require('dns');
const url = require('url');
const tls = require('tls');
const net = require('net');
const fs = require('fs');
const zlib = require('zlib');
const stringify = require('json-stable-stringify');
const find_iface = require('./find_iface.js');
const stream = require('stream');
const request = require('request');
const request_stats = require('request-stats');
const util = require('util');
const log = require('./log.js');
const username = require('./username.js');
const http_shutdown = require('http-shutdown');
const Socks = require('./socks.js');
const ssl = require('./ssl.js');
const hutil = require('hutil');
const version = require('../package.json').version;
const etask = hutil.etask;
const zurl = hutil.url;
const zutil = hutil.util;
const restore_case = hutil.http_hdr.restore_case;
const analytics = require('universal-analytics');
const ua = analytics('UA-60520689-2');
const qw = hutil.string.qw;
const assign = Object.assign;
const E = module.exports = Luminati;
const zproxy_port = 22225;
E.pool_types = {
    sequential: 0,
    'round-robin': 1,
    //fastest: 2,
};
E.user_agent = 'luminati-proxy-manager/'+version;
E.hola_agent = 'proxy='+version+' node='+process.version+
    ' platform='+process.platform;
E.default = {
    port: 24000,
    iface: '0.0.0.0',
    customer: process.env.LUMINATI_CUSTOMER,
    password: process.env.LUMINATI_PASSWORD,
    zone: process.env.LUMINATI_ZONE||'static',
    log: 'error',
    proxy: 'zproxy.luminati.io',
    proxy_port: zproxy_port,
    proxy_count: 1,
    session_init_timeout: 5,
    allow_proxy_auth: false,
    pool_type: 'sequential',
    sticky_ip: false,
    insecure: false,
    secure_proxy: false,
    short_username: false,
    ssl: false,
};
E.dropin = assign({}, E.default, {
    port: zproxy_port,
    multiply: false,
    sticky_ip: true,
    allow_proxy_auth: true,
    pool_size: 0,
    max_requests: 0,
    keep_alive: false,
    session_duration: 0,
    session: false,
    seed: false,
});

let write_http_reply = (_stream, res, headers)=>{
    headers = assign(headers||{}, res.headers||{});
    if (_stream.x_hola_context)
        headers['x-hola-context'] = _stream.x_hola_context;
    if (_stream.cred)
        headers['x-lpm-authorization'] = _stream.cred;
    if (_stream instanceof http.ServerResponse)
        return _stream.writeHead(res.statusCode, res.statusMessage, headers);
    let head = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
    for (let field in headers)
        head += `${field}: ${headers[field]}\r\n`;
    _stream.write(head+'\r\n');
};

let reverse_lookup_dns = ip=>etask(function*resolve(){
    let domains = yield etask.nfn_apply(dns, '.reverse', [ip]);
    return domains&&domains.length ? domains[0] : ip;
});

let reverse_lookup_values = values=>{
    const domains = {};
    for (let line of values)
    {
        const m = line.match(/^\s*(\d+\.\d+\.\d+\.\d+)\s+([^\s]+)/);
        if (m)
            domains[m[1]] = m[2];
    }
    return ip=>domains[ip]||ip;
};

function Luminati(opt){
    events.EventEmitter.call(this);
    this._refresh_sessions_emitter = new events.EventEmitter();
    this._refresh_sessions_emitter.setMaxListeners(Number.MAX_SAFE_INTEGER);
    this.http = opt.secure_proxy ? https : http;
    this.protocol = {
        http: new http.Agent({keepAlive: true, keepAliveMsecs: 5000}),
        https: new https.Agent({keepAlive: true, keepAliveMsecs: 5000,
            servername: 'zproxy.luminati.io'}),
    }[opt.secure_proxy ? 'https' : 'http'];
    opt = this.opt = assign({}, E.default, opt);
    if (opt.rules)
    {
        this.rules = new Rules(this, opt._rules);
        this.ipcache = new IPcache();
    }
    if (opt.session_duration)
    {
        this.session_duration = (''+opt.session_duration).split(':')
            .map(i=>+i*1000);
    }
    if (opt.max_requests)
    {
        if (opt.max_requests==0)
            this.max_requests = 0;
        else
        {
            this.max_requests = (''+opt.max_requests).split(':').map(i=>+i)
                .filter(i=>i);
        }
    }
    this.password = encodeURIComponent(opt.password);
    this._log = log(opt.port, opt.log);
    this.pool_type = E.pool_types[opt.pool_type]||E.pool_types.sequential;
    this.stats = {};
    this.lumtest = {failures: 0};
    this.active = 0;
    this.failure = {};
    this.requests_queue = [];
    this.throttle_queue = [];
    this.session_id = 1;
    this.sticky_sessions = {};
    this.keep_alive = opt.keep_alive && opt.keep_alive*1000;
    this.session_init_timeout = opt.session_init_timeout*1000;
    this.seed = opt.seed||
        Math.ceil(Math.random()*Number.MAX_SAFE_INTEGER).toString(16);
    if (opt.socks)
    {
        this.socks_server = new Socks({local: opt.socks, remote: opt.port,
            iface: opt.iface, log: opt.log});
    }
    if (opt.null_response)
        this.null_response = new RegExp(opt.null_response, 'i');
    if (opt.bypass_proxy)
        this.bypass_proxy = new RegExp(opt.bypass_proxy, 'i');
    if (opt.direct_include || opt.direct_exclude)
    {
        this.direct = {
            include: opt.direct_include && new RegExp(opt.direct_include, 'i'),
            exclude: opt.direct_exclude && new RegExp(opt.direct_exclude, 'i'),
        };
    }
    this.proxy_internal_bypass = opt.proxy_internal_bypass;
    this.dns_request = {
        url: 'https://client.luminati.io/api/get_super_proxy',
        qs: {
            user: `lum-customer-${opt.customer}-zone-${opt.zone}`,
            key: opt.password,
            limit: opt.proxy_count,
        },
    };
    this.http_server = http.createServer((req, res, head)=>{
        if (req.headers.host=='trigger.domain' ||
            /^\/hola_trigger/.test(req.url))
        {
            return res.end();
        }
        if (!req.url.startsWith('http:'))
            req.url = 'http://'+req.headers.host+req.url;
        this._handler(req, res, head);
    }).on('connection', socket=>socket.setNoDelay());
    http_shutdown(this.http_server);
    if (opt.ssl)
    {
        this.authorization = {};
        this.https_server = https.createServer(
            assign({requestCert: false}, ssl()),
            (req, res, head)=>{
                let authorization = this.authorization[req.socket.remotePort];
                if (authorization)
                    req.headers['proxy-authorization'] = authorization;
                this._handler(req, res, head);
            }
        ).on('connection', socket=>socket.setNoDelay());
        http_shutdown(this.https_server);
        this.http_server.on('connect', (req, res, head)=>{
            write_http_reply(res, {statusCode: 200, statusMessage: 'OK'});
            const socket = net.connect({host: '127.0.0.1',
                port: this.https_server.address().port});
            socket.setNoDelay();
            let port, authorization = req.headers['proxy-authorization'];
            if (authorization)
            {
                socket.on('connect', ()=>{
                    port = socket.localPort;
                    this.authorization[port] = authorization;
                }).on('close', ()=>delete this.authorization[port]);
            }
            socket.on('error', err=>this._log.error('Socket error:', {
                authorization: authorization,
                error: err,
                port: (this.https_server.address()||{}).port
            }));
            res.pipe(socket).pipe(res);
            req.on('end', ()=>socket.end());
        });
    }
    else
        this.http_server.on('connect', this._handler.bind(this));
    if ((opt.max_requests || opt.session_duration || this.keep_alive) &&
        !opt.pool_size && !opt.sticky_ip)
    {
        // XXX lee, gilad - can this warning be removed
        this._log.warn('empty pool_size, session flags are ignored');
    }
    if (opt.history && opt.history_aggregator)
    {
        this.on('response', response=>{
            let headers = response.headers||{};
            let proxy_info = qw`x-hola-timeline-debug
                x-hola-unblocker-debug`
                .map(h=>headers[h]||'')
                .map(h=>h.match(/(\d+\.\d+\.\d+\.\d+) ([^ ]+)/))
                .find(i=>i)||['', '', ''];
            let node_latency = +((headers['x-hola-timeline-debug']||'')
                .match(/(\d+) ?ms/)||[0, response.timeline.response])[1];
            this._timeout(()=>{
                let data = {
                    port: this.port,
                    url: response.request.url,
                    method: response.request.method,
                    request_headers: stringify(response.request.headers),
                    request_body: response.request.body,
                    response_headers: stringify(headers),
                    status_code: response.status_code,
                    status_message: response.status_message,
                    timestamp: response.timeline.start,
                    elapsed: response.timeline.end,
                    response_time: response.timeline.response,
                    node_latency: node_latency,
                    proxy_peer: proxy_info[1]||headers['x-hola-ip'],
                    country: proxy_info[2],
                    timeline: stringify(response.timeline),
                    content_size: response.body_size,
                    context: response.context,
                };
                if (response.proxy)
                {
                    data.super_proxy = response.proxy.host;
                    data.username = response.proxy.username;
                }
                opt.history_aggregator(data);
            }, 0);
        });
    }
    if (opt.reverse_lookup_dns===true)
        this.reverse_lookup = reverse_lookup_dns;
    else if (opt.reverse_lookup_file && fs.existsSync(opt.reverse_lookup_file))
    {
        this.reverse_lookup = reverse_lookup_values(
            hutil.file.read_lines_e(opt.reverse_lookup_file));
    }
    else if (opt.reverse_lookup_values)
        this.reverse_lookup = reverse_lookup_values(opt.reverse_lookup_values);
}

util.inherits(E, events.EventEmitter);

E.prototype._timeout = function(func, time, param){
    return setTimeout(()=>{
        try {
            func.call(this, param);
        } catch(e){
            this._log.error('Async error', e);
            this._log.silly(e.stack, etask.ps());
        }
    }, time);
};

E.prototype.reset_total_stats = function reset_total_stats(){
    for (var key in this.stats)
        this.stats[key] = get_zero_stats();
};

E.prototype.calculate_username = function(opt){
    opt = assign.apply({}, [this.opt, this, opt].map(o=>_.pick(o||{},
        qw`customer zone country state city session asn dns request_timeout
        cid ip raw direct debug password`)));
    let opt_usr = _.omit(opt, qw`request_timeout password`);
    if (opt_usr.ip)
        opt_usr = _.omit(opt_usr, qw`session`);
    if (opt.request_timeout)
        opt_usr.timeout = opt.request_timeout;
    return {username: username.calc(opt_usr, this.opt.short_username),
        password: opt.password};
};

E.prototype._handler = etask._fn(
function*_handler(_this, req, res, head){
    req._queued = Date.now();
    _this.active++;
    _this.emit('idle', false);
    this.finally(()=>{
        if (this.error)
        {
            if (!(this.error.message||'').includes('ECONNRESET'))
            {
                _this._log.error(`${req.method} ${req.url} - ${this.error}`);
                _this._log.silly(this.error.stack, etask.ps());
            }
            if (!res.ended)
            {
                write_http_reply(res, {statusCode: 502, statusMessage:
                    'Bad Gateway', headers: {Connection: 'close'}});
            }
            res.end();
        }
        if (--_this.active)
        {
            if (_this.throttle_queue.length)
            {
                _this._log.debug('Taking request from throttle queue');
                _this.throttle_queue.shift().continue();
            }
            return;
        }
        _this.emit('idle', true);
    });
    req.on('error', this.throw_fn());
    res.on('error', this.throw_fn());
    req.on('timeout', ()=>this.throw(new Error('request timeout')));
    this.info.url = req.url;
    if (_this.opt.throttle && _this.active>_this.opt.throttle)
    {
        _this._log.debug('Placing request on throttle queue');
        _this.throttle_queue.push(this);
        yield this.wait();
    }
    if (_this.opt.only_bypass || _this.hosts && _this.hosts.length)
        return yield _this._request(req, res, head);
    _this.requests_queue.push([req, res, head]);
});

E.prototype.refresh_sessions = etask._fn(
function*refresh_sessions(_this){
    _this._log.info('Refreshing all sessions');
    _this._refresh_sessions_emitter.emit('refresh_sessions');
    if (_this.opt.pool_size)
    {
        if (_this.pool_type==E.pool_types.sequential && _this.sessions
            && _this.sessions.length)
        {
            _this.sessions.shift();
            yield _this._pool_fetch();
        }
        else
        {
            // XXX marka/lee: set flag for other instncies of current session
            // that can be in use (in _pool_fetch)
            if (_this.sessions)
                _this.sessions.canceled = true;
            _this.sessions = [];
            yield _this._pool(_this.opt.pool_size);
        }
    }
    if (_this.opt.sticky_ip)
    {
        _this.sticky_sessions.canceled = true;
        _this.sticky_sessions = {};
    }
    if (_this.opt.session==true && _this.session)
    {
        _this.stop_keep_alive(_this.session);
        _this.session = null;
    }
});

E.prototype.error_handler = function error_handler(source, err){
    this._log.error(source+' error', err);
    this._log.silly(err, err.stack, etask.ps());
    if (err.code=='EADDRINUSE')
    {
        err = new Error('There\'s already an application which runs on '
            +err.address+':'+err.port);
        err.raw = true;
    }
    this.emit('error', err);
    throw err;
};

E.prototype.listen = etask._fn(function*listen(_this, port, hostname){
    _this.proxy = [].concat(_this.opt.proxy);
    _this.resolve_proxy();
    let _http = _this.http_server, _https = _this.https_server;
    let _socks = _this.socks_server;
    port = port||_this.opt.port||0;
    hostname = hostname||find_iface(_this.opt.iface);
    if (!hostname)
    {
        hostname = '0.0.0.0';
        _this.opt.iface = '0.0.0.0';
    }
    _http.on('error', err=>_this.error_handler('HTTP', err));
    yield etask.nfn_apply(_http, '.listen', [port, hostname]);
    _this.port = _http.address().port;
    if (_https)
    {
        _https.on('error', err=>_this.error_handler('HTTPS', err));
        yield etask.nfn_apply(_https, '.listen', [0, '127.0.0.1']);
        _this._log.debug('HTTPS port: '+_https.address().port);
    }
    if (_socks)
    {
        _socks.on('error', err=>_this.error_handler('SOCKS', err));
        yield _socks.start();
    }
    _this.emit('ready');
    return _this;
});

E.prototype.stop = etask._fn(function*stop(_this, force){
    if (_this.stopped)
        return;
    _this.stopped = true;
    let tasks = {};
    const stop_method = force ? '.forceShutdown' : '.shutdown';
    tasks.http = etask.nfn_apply(_this.http_server, stop_method, []);
    if (_this.https_server)
        tasks.https = etask.nfn_apply(_this.https_server, stop_method, []);
    if (_this.socks_server)
        tasks.socks = _this.socks_server.stop(force);
    yield etask.all(tasks);
    return _this;
});

E.prototype._check_proxy_response = etask._fn(
function*_check_proxy_response(_this, proxy, res, context){
    if (!_this.opt.proxy_switch)
        return;
    if (![403, 429, 502, 503].includes(res&&res.statusCode||0))
        return delete _this.failure[proxy];
    _this._log.warn('invalid proxy response',
        {host: proxy, code: res.statusCode, context: context});
    if ((_this.failure[proxy] =
        (_this.failure[proxy]||0)+1)<_this.opt.proxy_switch)
    {
        return;
    }
    _this._log.warn('removing failed proxy server', {host: proxy});
    if (_this.hosts)
    {
        _this.hosts = _this.hosts.filter(h=>h!=proxy);
        if (_this.opt.proxy_cache)
            _this.opt.proxy_cache.remove(proxy);
    }
    if (_this.sessions)
        _this.sessions = _this.sessions.filter(s=>s.proxy!=proxy);
    delete _this.failure[proxy];
    yield _this.resolve_proxy();
});

let get_zero_stats = ()=>{
    return {total_requests: 0, total_inbound: 0, total_outbound: 0,
        active_requests: 0, max_requests: 0, status_code: {}};
};

E.prototype.resolve_proxy = etask._fn(function*resolve_proxy(_this){
    if (_this.opt.only_bypass)
        return;
    let hosts = {}, proxies = _this.proxy.slice(0);
    let dns_request = _this.dns_request;
    if (!_this.hosts && _this.opt.proxy_cache)
        _this.hosts = yield _this.opt.proxy_cache.get(proxies);
    _this.resolving_proxies = true;
    [].concat(_this.hosts||[]).forEach(h=>hosts[h] = false);
    const timestamp = Date.now();
    while (proxies.length && Object.keys(hosts).length<_this.opt.proxy_count &&
        Date.now()-timestamp<30000)
    {
        let proxy = proxies.shift(), ips;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(proxy))
        {
            _this._log.debug(`using super proxy ${proxy}`);
            hosts[proxy] = false;
            continue;
        }
        proxies.push(proxy);
        let domain = proxy;
        if (proxy.length==2)
            domain = 'zproxy.luminati.io';
        if (domain=='zproxy.luminati.io')
        {
            domain = `customer-${_this.opt.customer}-`
                +`session-${Date.now()}.${domain}`;
        }
        if (0 && dns_request)
        {
            try {
                let res = yield etask.nfn_apply(request, [dns_request]);
                if (res.statusCode==200)
                {
                    ips = JSON.parse(res.body).proxies;
                    continue;
                }
                else if (res.statusCode>=400 && res.statusCode<500)
                {
                    _this._log.error('Invalid resolve code',
                        {code: res.statusCode, body: res.body});
                    delete _this.dns_request;
                    dns_request = null;
                }
                else
                {
                    _this._log.warn('Invalid resolve code',
                        {code: res.statusCode, body: res.body});
                    yield etask.sleep(5000);
                }
            } catch(e){
                _this._log.debug(`Failed to http resolve proxies: ${e}`);
                dns_request = null;
            }
        }
        try {
            ips = ips || (yield etask.nfn_apply(dns, '.resolve', [domain]));
            _this._log.debug(`resolved ${proxy} (${domain})`, ips);
            ips.forEach(ip=>hosts[ip] = proxy);
        } catch(e){
            _this._log.debug(`Failed to resolve ${proxy} (${domain}): ${e}`);
            _this._log.silly(e.stack, etask.ps());
        }
    }
    _this.hosts = _.shuffle(Object.keys(hosts));
    if (_this.opt.proxy_cache)
        yield _this.opt.proxy_cache.add(_.toPairs(hosts).filter(p=>p[1]));
    if (!_this.hosts.length)
        _this._log.error('Failed to resolve any proxies');
    _this.hosts.forEach(h=>{
        if (_this.stats[h])
            return;
        _this.stats[h] = get_zero_stats();
        _this._log.info('adding proxy server', {host: h});
    });
    _this.resolving_proxies = false;
    let queue = _this.requests_queue;
    _this.requests_queue = [];
    queue.forEach(args=>_this._request.apply(_this, args));
});

E.hola_headers = qw`proxy-connection proxy-authentication x-hola-agent
    x-hola-debug x-hola-tunnel-key x-hola-tunnel-ip x-hola-tunnel-session
    x-hola-auth x-hola-unblocker-debug x-hola-session x-hola-cid
    x-hola-country x-hola-forbid-peer x-hola-dst-ips x-hola-ip
    x-hola-immediate x-hola-dns-only x-hola-response x-hola-direct-first
    x-hola-direct-discover x-hola-blocked-response x-hola-conf
    x-hola-headers-only x-hola-unblocker-bext x-hola-dynamic-tunnels
    x-hola-context x-luminati-timeline`;

E.prototype.connect_proxy = etask._fn(
function*connect_proxy(_this, session, timeout, context){
    let host = session.host || _this.hosts[0];
    let cred = _this.calculate_username(session);
    _this._log.silly('connect_proxy', cred.username, host);
    const timeline = {start: Date.now()};
    let opt = {
        hostname: host,
        port: _this.opt.proxy_port,
        method: 'HEAD',
        path: 'http://lumtest.com/myip.json',
        agent: _this.protocol,
        timeout,
        rejectUnauthorized: !_this.opt.insecure,
        proxyHeaderWhiteList: E.hola_headers,
        proxyHeaderExclusiveList: E.hola_headers,
        headers: {
            host: 'lumtest.com',
            'proxy-authorization': 'Basic '
                +new Buffer(`${cred.username}:${cred.password}`)
                .toString('base64'),
            'x-hola-agent': E.hola_agent,
            'x-hola-direct-first': true,
        }
    };
    const res = {
        request: {
            method: opt.method,
            url: opt.path,
            headers: opt.headers,
        },
        timeline: timeline,
        context: context,
        proxy: {
            host: host,
            username: cred.username,
        }
    };
    let err, info;
    try {
        _this.http.request(opt).on('response', _res=>{
            _this._log.silly('connect_proxy response', _res.statusCode,
                _res.statusMessage, _res.headers);
            timeline.response = Date.now() - timeline.start;
            assign(res, {
                status_code: _res.statusCode,
                status_message: _res.statusMessage,
                headers: _res.headers,
                raw_headers: _res.rawHeaders,
            });
            if (_res.statusCode==302 && _res.headers['x-hola-response']==1)
                info = {};
            _res.on('end', ()=>{
                timeline.end = Date.now() - timeline.start;
                this.continue();
            }).resume();
        }).on('error', _err=>{ err = _err; this.continue(); }).end();
        yield this.wait();
        _this._log.debug('connect_proxy', res.status_code, res.status_message,
            info);
        if (err)
            throw err;
       _this.emit('response', res);
    } catch(e){
        err = e;
        res.status_code = 502;
        _this._log.warn('connect_proxy', err);
        _this._log.silly(err.stack, etask.ps());
    }
    return {res, err, info};
});

E.prototype.info_request = etask._fn(
function*info_request(_this, session, timeout, context){
    if (!_this.opt.session_info && context!='SESSION INFO')
        return yield _this.connect_proxy(session, timeout, context);
    let host = session.host || _this.hosts[0];
    let cred = _this.calculate_username(session);
    let protocol = _this.opt.secure_proxy ? 'https' : 'http';
    let proxy_url = `${protocol}://${cred.username}:${cred.password}@${host}:${_this.opt.proxy_port}`;
    _this._log.silly('info_request via ', proxy_url);
    let opt = {
        url: 'http://lumtest.com/myip.json',
        proxy: proxy_url,
        timeout: timeout,
        headers: {
            'x-hola-agent': E.hola_agent,
            host: 'zproxy.hola.org',
        },
        proxyHeaderWhiteList: E.hola_headers,
        proxyHeaderExclusiveList: E.hola_headers,
    };
    const timeline = {start: Date.now()};
    const res = {
        request: {
            method: 'GET',
            url: opt.url,
            headers: opt.headers,
            body: '',
        },
        timeline: timeline,
        context: context,
        body: '',
        proxy: {
            host: host,
            username: cred.username,
        }
    };
    let err, info;
    try {
        request(opt).on('response', _res=>{
            timeline.response = Date.now() - timeline.start;
            assign(res, {
                status_code: _res.statusCode,
                status_message: _res.statusMessage,
                headers: _res.headers,
                raw_headers: _res.rawHeaders,
            });
        }).on('data', data=>res.body+=data)
        .on('error', _err=>{
            err = _err;
            this.continue();
        }).on('end', ()=>{
            timeline.end = Date.now() - timeline.start;
            this.continue();
        });
        yield this.wait();
        if (err)
            throw err;
        res.body_size = res.body.length;
        if (res.status_code==200 && res.headers['content-type'].match(/\/json/))
            info = JSON.parse(res.body);
       _this.emit('response', res);
       _this._log.debug('info_request', res, info);
    } catch(e){
        err = e;
        res.status_code = 502;
        _this._log.warn('info_request', err);
        _this._log.silly(err.stack, etask.ps());
    }
    return {res, err, info};
});

E.prototype._establish_session = etask._fn(
function*_establish_session(_this, prefix, pool){
    while (!pool.canceled && !_this.stopped)
    {
        if (_this.lumtest.failures)
        {
            let sleep = Math.min(_this.lumtest.failures, 60);
            _this._log.error(`pool ${prefix} delayed ${sleep} second(s)...`);
            yield etask.sleep(sleep * 1000);
        }
        let host = _this.hosts.shift();
        _this.hosts.push(host);
        let session_id = `${prefix}_${_this.session_id++}`;
        let ips = _this.opt.ips||[];
        let ip = ips[_this.session_id%ips.length];
        let cred = _this.calculate_username({ip: ip, session: session_id});
        let session = {
            host: host,
            session: session_id,
            ip: ip,
            count: 0,
            bandwidth_max_downloaded: 0,
            created: Date.now(),
            stats: true,
            username: cred.username,
            pool: pool,
        };
        _this._log.debug(`establishing new session ${host}:${session_id}`);
        let err, res;
        try {
            res = yield _this.info_request(session,
                _this.session_init_timeout, 'SESSION INIT');
            yield _this._check_proxy_response(host, res.res, {from:
                'session_init', error: res.err});
            if (res.info)
            {
                session.info = res.info;
                _this._log.info(`new session added ${host}:${session_id}`,
                    {ip: res.info.ip});
                const max_requests = _this.max_requests;
                if (max_requests && !session.max_requests)
                {
                    session.max_requests = max_requests[0];
                    if (max_requests.length>1)
                    {
                        session.max_requests += Math.floor(Math.random()*
                            (max_requests[1]-max_requests[0]+1));
                    }
                }
                _this.set_keep_alive(session);
                _this.lumtest = {failures: 0};
                return session;
            }
        } catch(e){ err = e; }
        _this.lumtest.failures++;
        _this._log.warn(
            `Failed to establish session ${host}:${session_id}`, {
                error: err||res.err,
                code: res.res.status_code,
                headers: res.res.headers,
                body: res.res.body,
            });
   }
});

E.prototype._pool_fetch = etask._fn(function*pool_fetch(_this){
    let pool = _this.sessions;
    let session = yield _this._establish_session(
        `${_this.port}_${_this.seed}`, pool);
    pool.push(session);
});

E.prototype._pool = etask._fn(function*pool(_this, count){
    if (!count)
        return;
    let tasks = [];
    for (let i=0; i<count; i++)
        tasks.push(_this._pool_fetch());
    yield etask.all(tasks);
});

E.prototype.update_session = etask._fn(function*(_this, session){
    const res = yield _this.info_request(session,
        _this.opt.request_timeout, 'SESSION INFO');
    session.info = res.info;
});

E.prototype.update_all_sessions = etask._fn(function*(_this){
    if (_this.sessions)
    {
        for (let i=0; i<_this.sessions.length; i++)
            yield _this.update_session(_this.sessions[i]);
    }
});

E.prototype.set_keep_alive = function(session){
    if (!this.keep_alive)
        return;
    this.stop_keep_alive(session);
    session.keep_alive = this._timeout(this._keep_alive_handler,
        this.keep_alive, session);
    this._log.debug(`Schedule keep alive ${session.host}:${session.session}`);
};

E.prototype._keep_alive_handler = function(session){
    if (session.pool.canceled || this.stopped)
        return;
    this.set_keep_alive(session);
    this._log.info(`Keep alive ${session.host}:${session.session}`);
    this.info_request(session, this.opt.request_timeout,
        'SESSION KEEP ALIVE')
    .then(res=>{
        if (session && res && res.info)
            session.info = res.info;
    });
};

E.prototype.stop_keep_alive = function(session){
    if (!session.keep_alive)
        return;
    clearTimeout(session.keep_alive);
    session.keep_alive = null;
};

E.prototype.is_session_expired = function(session){
    if (!session)
        return true;
    this.set_keep_alive(session);
    const now = Date.now();
    const duration = this.session_duration;
    session.count++;
    if (duration && !session.expire)
    {
        session.expire = now+duration[0];
        if (duration.length>1)
        {
            session.expire += Math.floor(Math.random()*
                (duration[1]-duration[0]+1));
        }
    }
    let expired = session.max_requests && session.count>=session.max_requests
        || session.expire && now>session.expire;
    if (expired)
    {
        this.stop_keep_alive(session);
        this._log.info(`session ${session.session} expired`);
    }
    return expired;
};

E.prototype._request_session = etask._fn(
function*_request_session(_this, req, auth_header, only, src_addr){
    if (only)
        return;
    let authorization = _this.opt.allow_proxy_auth &&
        username.parse(auth_header);
    if (authorization)
    {
        if (authorization.timeout)
            authorization.request_timeout = authorization.timeout;
        _this._log.debug('Using request authorization', authorization);
        return {authorization};
    }
    if (_this.opt.pool_size)
    {
        if (!_this.sessions)
        {
            _this.sessions = [];
            yield _this._pool(_this.opt.pool_size);
            _this._log.debug(`initialized pool - ${_this.opt.pool_size}`);
            _this._pool_ready = true;
        }
        else
        {
            if (_this._pool_ready)
            {
                if (!_this.sessions.length)
                {
                    _this._log.warn('pool size is too small');
                    yield _this._pool_fetch();
                }
            }
            for (;; yield etask.sleep(1000))
            {
                if (!_this._pool_ready)
                    continue;
                if (_this.sessions.length)
                    break;
                _this._log.warn('pool size is too small');
                yield _this._pool_fetch();
                break;
            }
        }
        let session = _this.sessions[0];
        if (_this.pool_type==E.pool_types['round-robin'])
            _this.sessions.push(_this.sessions.shift());
        if (_this.is_session_expired(session))
        {
            if (_this.pool_type==E.pool_types['round-robin'])
                _this.sessions.pop();
            else
                _this.sessions.shift();
            yield _this._pool_fetch();
        }
        _this._log.debug('Selecting pool session', session&&session.session);
        return session;
    }
    if (_this.opt.sticky_ip)
    {
        const ip = src_addr.replace(/\./g, '_');
        if (!_this.sticky_sessions[ip])
        {
            _this.sticky_sessions[ip] = yield _this._establish_session(
                `${_this.port}_${ip}_${_this.seed}`, _this.sticky_sessions);
        }
        let session = _this.sticky_sessions[ip];
        if (_this.is_session_expired(session))
            _this.sticky_sessions[ip] = null;
        _this._log.debug('Selecting sticky session', session&&session.session);
        return session;
    }
    if (_this.opt.session===true)
    {
        if (!_this.session)
            _this.session = yield _this._establish_session(_this.seed, _this);
        let session = _this.session;
        if (_this.is_session_expired(session))
            _this.session = null;
        _this._log.debug('Selecting seed session', session&&session.session);
        return session;
    }
    if (_this.opt.session)
    {
        if (!_this.session)
        {
            _this.session = {
                session: _this.opt.session,
                count: 0,
                bandwidth_max_downloaded: 0,
                created: Date.now(),
                stats: true,
                pool: _this,
            };
        }
        let session = _this.session;
        _this.set_keep_alive(session);
        _this._log.debug('Selecting explicit session', session.session);
        return session;
    }
    _this._log.debug('Not using session');
    return {session: false};
});

E.prototype._bypass_proxy = function _bypass_proxy(_url, _ssl){
    let match_domain = (mask, hostname)=>{
        let mp = mask.split('.'), hp = hostname.split('.').slice(-mp.length);
        return mp.every((p, i)=>p=='*' || hp[i]==p);
    };
    if (this.bypass_proxy && this.bypass_proxy.test(_url))
        return true;
    let intern = this.proxy_internal_bypass, only = this.opt.only_bypass;
    if (!intern && !only)
        return false;
    let hostname = _ssl ? _url.split(':')[0] : url.parse(_url).hostname;
    return intern && intern.some(x=>match_domain(x, hostname))
        || only && only.some(x=>match_domain(x, hostname));
};

E.prototype._direct = function _direct(_url){
    return this.direct && (
        this.direct.include && this.direct.include.test(_url) ||
        !(this.direct.exclude && this.direct.exclude.test(_url)));
};

class IPcache {
    constructor(){
        this.cache = new Map();
    }
    ban(ip, ms){
        let c = this.cache.get(ip);
        let _this = this;
        if (!c)
            c = this.cache.set(ip, {ip: ip}).get(ip);
        else
            clearTimeout(c.to);
        c.to = setTimeout(()=>_this.cache.delete(c.ip), ms);
    }
    is_banned(ip){
        return this.cache.has(ip);
    }
}

class Rules {
    constructor(luminati, rules){
        rules = rules||{};
        this.luminati = luminati;
        this.rules = zutil.clone_deep(rules);
        this._pre = this.rules.pre;
        this._post = this.rules.post;
        if (this._pre)
        {
            for (let i=0; i<this._pre.length; i++)
            {
                let p = this._pre[i];
                p.url_re = new RegExp(zurl.http_glob_url(p.url, true));
            }
        }
        if (this._post)
        {
            for (let i=0; i<this._post.length; i++)
            {
                let p = this._post[i];
                p.url_re = new RegExp(zurl.http_glob_url(p.url, true));
                for (let j=0; j<p.res.length; j++)
                {
                    let r = p.res[j];
                    if (r.body)
                        p.need_body = true;
                }
            }
        }
    }
    pre(req){
        if (!this._pre)
            return;
        let url = req.url_full||req.url;
        for (let i=0; i<this._pre.length; i++)
        {
            let p = this._pre[i];
            if (!p.url_re.test(url))
                continue;
            if (p.session)
                req.session = this.gen_session();
            if (p.browser)
            {
                switch (p.browser)
                {
                case 'chrome':
                    req.headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0;'
                        +' WOW64) AppleWebKit/537.36 (KHTML, like Gecko) '
                        +'Chrome/56.0.2924.87 Safari/537.36';
                    req.headers.accept = 'text/html,application/xhtml+xml,'
                        +'application/xml;q=0.9,image/webp,*/*;q=0.8';
                    req.headers['accept-encoding'] = 'gzip, deflate, sdch, br';
                    req.headers['accept-language'] = 'en-US,en;q=0.8,he;q=0.6';
                    req.headers['upgrade-insecure-requests'] = '1';
                    break;
                case 'firefox':
                    req.headers['user-agent'] = 'Mozilla/5.0 (Windows NT 6.1; '
                        +'WOW64; rv:47.0) Gecko/20100101 Firefox/47.0';
                    req.headers['accept-encoding'] = 'gzip, deflate, br';
                    req.headers['accept-language'] = 'en-US,en;q=0.5';
                    req.headers.accept = 'text/html,application/xhtml+xml,'
                        +'application/xml;q=0.9,*/*;q=0.8';
                    req.headers['Upgrade-Insecure-Requests'] = '1';
                    req.headers['Cache-Control'] = 'max-age';
                    break;
                }
            }
        }
    }
    _cmp(rule, value){
        if (!rule)
            return false;
        let type = rule.type||'==';
        switch (type)
        {
        case '==': return rule.arg==value;
        case '!=': return rule.arg!=value;
        case '=~':
            if (!rule.arg_re)
                rule.arg_re = new RegExp(rule.arg);
            return rule.arg_re.test(value);
        case '!~':
            if (!rule.arg_re)
                rule.arg_re = new RegExp(rule.arg);
            return !rule.arg_re.test(value);
        case 'in': return rule.arg.includes(value);
        case '!in': return !rule.arg.includes(value);
        }
        return false;
    }
    cmp(rule, value){
        if (!rule)
            return false;
        if (!(rule instanceof Array))
        {
            if (rule.name)
                value = value[rule.name];
            return this._cmp(rule, value);
        }
        for (let i=0; i<rule.length; i++)
        {
            let r = rule[i], v = value;
            if (r.name)
                v = value[rule.name];
            if (this._cmp(r, v))
                return true;
        }
        return false;
    }
    post(req, res, head, _res, hdrs_only){
        if (!this._post)
            return;
        let url = req.url_full||req.url;
        for (let i=0; i<this._post.length; i++)
        {
            let p = this._post[i];
            if (!p.url_re.test(url))
                continue;
            for (let j=0; j<p.res.length; j++)
            {
                let r = p.res[j];
                if (hdrs_only && !r.head)
                    continue;
                if (r.ipban)
                {
                    let tl = _res.hola_headers['x-hola-timeline-debug']
                        .split(' ');
                    let ip = tl[3];
                    if (this.luminati.ipcache.is_banned(ip) &&
                        this.action(req, res, head, _res, r.action||p.action))
                    {
                        return true;
                    }
                }
                if (this.cmp(r.status, _res.statusCode))
                {
                    if (this.action(req, res, head, _res, r.action||p.action))
                        return true;
                }
                if (this.cmp(r.header, _res.headers))
                {
                    if (this.action(req, res, head, _res, r.action||p.action))
                        return true;
                }
            }
        }
    }
    post_body(req, res, head, _res, body){
        if (!this._post)
            return;
        let _body = Buffer.concat(body), s;
        switch (_res.headers['content-encoding'])
        {
        case 'gzip': s = zlib.gunzipSync(_body); break;
        case 'deflate': s = zlib.inflateSync(_body); break;
        default: s = _body; break;
        }
        _body = s.toString('utf8');
        let url = req.url_full||req.url;
        for (let i=0; i<this._post.length; i++)
        {
            let p = this._post[i];
            if (!p.need_body || !p.url_re.test(url))
                continue;
            for (let j=0; j<p.res.length; j++)
            {
                let r = p.res[j];
                if (!r.body)
                    continue;
                if (this.cmp(r.body, _body))
                {
                    if (this.action(req, res, head, _res, r.action||p.action))
                        return true;
                }
            }
        }
    }
    post_need_body(req){
        if (!this._post)
            return;
        let url = req.url_full||req.url;
        for (let i=0; i<this._post.length; i++)
        {
            let p = this._post[i];
            if (!p.url_re.test(url))
                continue;
            if (!p.need_body)
                continue;
            return true;
        }
        return false;
    }
    retry(req, res, head){
        if (!req.retry)
            req.retry = 0;
        req.retry++;
        this.luminati._log.info(`req retry${req.retry} ${req.url_full}`);
        this.luminati._request(req, res, head);
    }
    can_retry(req, response){
        let ret = (req.retry||0)<20;
        if (!ret)
        {
            ua.event('rules', 'max_retry', JSON.stringify({url: req.url_full,
                retry: req.retry, user: response&&response.proxy.username}));
        }
        return ret;
    }
    gen_session(){
        return 'rand'+Math.floor(Math.random()*9999999+1000000);
    }
    action(req, res, head, _res, action){
        if (action.retry==false)
            return false;
        if (action.ban_ip)
        {
            let t = 1;
            let n = action.ban_ip.match(/^(\d+)(ms|sec|min|hr|day)?$/);
            if (n)
            {
                t = +n[1];
                switch (n[2])
                {
                case 'day': t *= 24*60*60*1000; break;
                case 'hr': t *= 60*60*1000; break;
                case 'min': t *= 60*1000; break;
                case 'sec': t *= 1000; break;
                case 'ms': break;
                }
            }
            this.luminati.ipcache.ban(
                _res.hola_headers['x-hola-timeline-debug'].split(' ')[3], t);
            this.luminati.session = this.gen_session();
            this.retry(req, res, head);
            return true;
        }
        if (action.url)
        {
            let url = action.url;
            if (url=='location')
                url = _res.headers.location;
            req.url = url;
            this.retry(req, res, head);
            return true;
        }
        return false;
    }
}

E.prototype._send_null_response = function(_url, req, res, timeline, response){
    this._log.debug(`Returning null response: ${req.method} ${_url}`);
    let status = req.method=='CONNECT' ? 501 : 200;
    write_http_reply(res, {statusCode: status, statusMessage: 'NULL'});
    res.end();
    timeline.end = Date.now() - timeline.start;
    response.status_code = status;
    response.status_message = 'NULL';
    this.emit('response', response);
};

E.prototype._request = etask._fn(function*_request(_this, req, res, head){
    if (_this.rules)
    {
        if (!req.url_full)
        {
            req.url_full = req.socket instanceof tls.TLSSocket ?
                'https://'+req.headers.host+req.url : req.url;
        }
        if (!req.saved_hdrs)
            req.saved_hdrs = assign({}, req.headers);
        else
            req.headers = assign({}, req.saved_hdrs);
        _this.rules.pre(req); // XXX shachar: can it redirect from here?
    }
    let _url = req.url, only = _this.opt.only_bypass;
    const context = res.x_hola_context = req.headers['x-hola-context'];
    delete req.headers['x-hola-context'];
    const auth_header = req.headers['proxy-authorization'];
    delete req.headers['proxy-authorization'];
    delete req.headers['x-hola-agent'];
    let src_addr = req.connection.remoteAddress;
    if (src_addr=='127.0.0.1' && req.headers['x-lpm-src-addr'])
        src_addr = req.headers['x-lpm-src-addr'];
    delete req.headers['x-lpm-src-addr'];
    const timeline = {start: Date.now()};
    if (req._queued)
        timeline.queued = req._queued-timeline.start;
    const headers = _this.rules ? req.headers :
        restore_case(req.headers, req.rawHeaders);
    const response = {
        request: {
            method: req.method,
            url: _url,
            headers: headers,
            raw_headers: req.rawHeaders,
            body: '',
        },
        timeline: timeline,
        body_size: 0,
        context: context,
        body: [],
    };
    [req, res].forEach(r=>qw`data end`.forEach(e=>{
        let ev;
        if (r[ev = `_on${e}`])
        {
            r.removeListener(e, r[ev]);
            delete r[ev];
        }
    }));
    req.on('data', req._ondata = chunk=>{ response.request.body += chunk; });
    // XXX ovidiu: remove this when eventemitter possible leak fixed
    res.setMaxListeners(45);
    if (req.method=='CONNECT')
    {
        let parts = _url.split(':');
        if (parts[0].match(/^\d+\.\d+\.\d+\.\d+$/) && _this.reverse_lookup)
            parts[0] = yield _this.reverse_lookup(parts[0])||parts[0];
        _url = parts.join(':');
        if (parts[0].match(/^\d+\.\d+\.\d+\.\d+$/))
            _this._log.warn('HTTPS connection to IP: ', _url);
    }
    if (req.socket instanceof tls.TLSSocket)
        _url = 'https://'+req.headers.host+_url;
    response.request.url_full = _url;
    _this._log.info(`${req.method} ${_url}`);
    if (_this.null_response && _this.null_response.test(_url))
    {
        _this._log.debug(`requested url ${_url} matches null_response filter `+
            _this.null_response);
        return _this._send_null_response(_url, req, res, timeline, response);
    }
    if (!only && !_this.hosts.length)
    {
        if (_this.resolving_proxies)
            return _this.requests_queue.push([req, res, head]);
        return this.throw(new Error('No hosts when processing request'));
    }
    let session = yield _this._request_session(req, auth_header, only,
        src_addr);
    if (session && !session.session)
    {
        if (req.session)
            session.session = req.session;
        else if (!_this.session && _this.rules)
        {
            _this.session = _this.rules.gen_session();
            session.session = _this.session;
        }
        else if (_this.session)
            session.session = _this.session;
    }
    let host = session&&session.host || (only ? '127.0.0.1' : _this.hosts[0]);
    let stats = _this.stats[host];
    if (!stats)
    {
        stats = _this.stats[host] = get_zero_stats();
        _this._log.debug('adding stats for', host);
    }
    stats.active_requests++;
    stats.max_requests = Math.max(stats.max_requests, stats.active_requests);
    request_stats(req, res, rstats=>{
        stats.total_requests++;
        const downloaded = rstats.res.bytes;
        const uploaded = rstats.req.bytes;
        stats.total_inbound += downloaded;
        stats.total_outbound += uploaded;
        if (session && session.stats &&
            downloaded>=session.bandwidth_max_downloaded)
        {
            session.bandwidth_max_downloaded = downloaded;
            session.bandwidth = Math.round(
                downloaded*1000/(Date.now()-timeline.start));
        }
    });
    const handler = (proxy, _headers)=>etask(function*(){
        const count = new stream.Transform({
            transform(data, encoding, cb){
                response.body_size += data.length;
                cb(null, data);
            },
        });
        proxy.on('response', _res=>{
            try {
                timeline.response = Date.now()-timeline.start;
                stats.active_requests--;
                let code = `${_res.statusCode}`.replace(/(?!^)./g, 'x');
                stats.status_code[code] = (stats.status_code[code]||0)+1;
                _this._log.debug(`${req.method} ${_url} - ${_res.statusCode}`);
                if (_this.rules)
                {
                    _res.hola_headers = _headers;
                    if (!_this.rules.can_retry(req));
                    else if (_this.rules.post(req, res, head, _res, true))
                    { // retry: true
                        req.unpipe(proxy);
                        proxy.end();
                        this.return();
                        return;
                    }
                    else if (_this.rules.post_need_body(req))
                    {
                        response.body_wait = true;
                        response._res = _res;
                        _res.on('data', data=>response.body.push(data));
                        _res.on('end', ()=>{
                            if (_this.rules.post_body(req, res, head, _res,
                                response.body))
                            {
                                req.unpipe(proxy);
                                proxy.end();
                                this.return();
                                return;
                            }
                            write_http_reply(res, _res, _headers);
                            for (let i=0; i<response.body.length; i++)
                                res.write(response.body[i]);
                            res.end();
                            timeline.end = Date.now()-timeline.start;
                            assign(response, {
                                status_code: _res.statusCode,
                                status_message: _res.statusMessage,
                                headers: assign({}, _res.headers,
                                _headers||{}),
                            });
                            _this._log.debug(util.inspect(response,
                                {depth: null, colors: 1}));
                            _this.emit('response', response);
                            _this._check_proxy_response(host, _res,
                                'response');
                            this.return();
                        }).on('error', this.throw_fn());
                        return;
                    }
                }
                write_http_reply(res, _res, _headers);
                _res.pipe(count).pipe(res);
                _res.on('end', ()=>{
                    timeline.end = Date.now()-timeline.start;
                    assign(response, {
                        status_code: _res.statusCode,
                        status_message: _res.statusMessage,
                        headers: assign({}, _res.headers, _headers||{}),
                    });
                    _this._log.debug(util.inspect(response,
                        {depth: null, colors: 1}));
                    _this.emit('response', response);
                    _this._check_proxy_response(host, _res, 'response');
                    this.return();
                }).on('error', this.throw_fn());
            } catch(e){ this.throw(e); }
        }).on('connect', (_res, socket, _head)=>{
            try {
                timeline.connect = Date.now()-timeline.start;
                stats.active_requests--;
                write_http_reply(res, _res);
                assign(response, {
                    status_code: _res.statusCode,
                    headers: _res.headers,
                });
                if (_res.statusCode!=200)
                {
                    _this._log.error(
                        `${req.method} ${_url} - ${_res.statusCode}`);
                    res.end();
                    _this.emit('response', response);
                    _this._check_proxy_response(host, _res, 'connect');
                    return this.return();
                }
                _this._log.debug(`CONNECT - ${_res.statusCode}`);
                socket.write(head);
                res.write(_head);
                socket.pipe(count).pipe(res).pipe(socket);
                let end_socket = ()=>socket.end();
                _res.on('error', this.throw_fn());
                socket.on('error', err=>{
                    _this._log.error('Request socket error', {error: err});
                    _this._log.silly(err, err.stack, etask.ps());
                    _this._refresh_sessions_emitter
                        .removeListener('refresh_sessions', end_socket);
                }).on('end', ()=>{
                    if (timeline.end==undefined)
                    {
                        timeline.end = Date.now()-timeline.start;
                        _this.emit('response', response);
                    }
                    _this._refresh_sessions_emitter
                        .removeListener('refresh_sessions', end_socket);
                    this.return();
                });
                _this._refresh_sessions_emitter
                    .once('refresh_sessions', end_socket);
            } catch(e){ this.throw(e); }
        }).on('error', err=>{
            if (_this.rules && _this.rules.can_retry(req))
            {
                _this._log.warn(`error proxy response ${host}`);
                _this.rules.retry(req, res, head);
                req.unpipe(proxy);
                proxy.end();
                this.return();
                return;
            }
            _this._check_proxy_response(host, {statusCode: 502}, {from:
                'error', error: err});
            this.throw(err);
        });
        yield this.wait();
    });
    const _ssl = req.method=='CONNECT';
    if (_this._bypass_proxy(_url, _ssl))
    {
        let proxy;
        if (_ssl)
        {
            const parts = _url.split(':');
            response.request.url = `https://${_url}/`;
            proxy = net.connect({host: parts[0], port: +parts[1]});
            proxy.on('connect', ()=>{
                timeline.direct_connect = Date.now()-timeline.start;
                stats.active_requests--;
                _this._log.debug(`DIRECT CONNECT - ${_url}`);
                write_http_reply(res, {statusCode: 200, statusMessage: 'OK'});
                res.pipe(proxy).pipe(res);
            });
        }
        else
        {
            proxy = request({
                uri: _url,
                host: url.parse(_url).hostname,
                method: req.method,
                path: req.url,
                headers: headers,
                rejectUnauthorized: !_this.opt.insecure,
            });
            proxy.on('connect', (_res, socket)=>{
                timeline.direct_connect = Date.now()-timeline.start;
                stats.active_requests--;
                _res.on('error', this.throw_fn());
                socket.on('error', this.throw_fn());
                _this._log.debug(`DIRECT REQUEST - ${_url}`);
            });
            // XXX jesse remove duplication of this block
            if (response.request.body)
                proxy.write(response.request.body);
            req.pipe(proxy);
        }
        proxy.on('close', ()=>{
            timeline.end = Date.now()-timeline.start;
            _this.emit('response', response);
            this.return();
        }).on('error', this.throw_fn());
        if (!_ssl)
            yield handler(proxy);
        return yield this.wait();
    }
    else if (only)
        return _this._send_null_response(_url, req, res, timeline, response);
    let cred = _this.calculate_username(assign({}, {
        ip: session&&session.ip||_this.opt.ip,
        session: session&&session.session,
        direct: _this._direct(_url),
    }, session&&session.authorization||{}));
    res.cred = cred.username;
    _this._log.info(`requesting using ${cred.username}`);
    response.proxy = {
        host: host,
        username: cred.username,
    };
    const connect_headers = {
        'proxy-authorization': 'Basic '+
            new Buffer(cred.username+':'+cred.password).toString('base64'),
        'x-hola-agent': E.hola_agent,
    };
    if (req.socket instanceof tls.TLSSocket)
    {
        let _etask = this;
        response.request.url = `https://${req.headers.host}${req.url}`;
        _this.http.request({
            host: host,
            port: _this.opt.proxy_port,
            method: 'CONNECT',
            path: req.headers.host+':443',
            headers: connect_headers,
            agent: _this.protocol,
            rejectUnauthorized: !_this.opt.insecure,
        }).on('connect', (_res, socket, _head)=>etask(function*(){
            if (_res.statusCode!=200)
            {
                if (_this.rules && _this.rules.can_retry(req))
                {
                    _this._log.warn(`error proxy response ${host}`);
                    _this.rules.retry(req, res, head);
                    _etask.return();
                    return;
                }
                _this._check_proxy_response(host,
                    {statusCode: _res.statusCode}, {from:
                    'error', error: _res.statusMessage});
                this.throw(_res.statusMessage);
                return;
            }
            if (_this.ipcache)
            {
                let tl = (_res.headers['x-hola-timeline-debug']||'')
                    .split(' ');
                let ip = tl && tl.length>=3 && tl[3];
                if (ip && _this.ipcache.is_banned(ip))
                {
                    _this._log.info(`ip_banned ${ip}`);
                    _this.rules.retry(req, res, head);
                    _etask.return();
                    return;
                }
            }
            timeline.connect = Date.now()-timeline.start;
            _res.on('error', this.throw_fn());
            socket.on('error', this.throw_fn());
            const proxy = https.request({
                host: req.headers.host,
                method: req.method,
                path: req.url,
                headers: headers,
                proxyHeaderWhiteList: E.hola_headers,
                proxyHeaderExclusiveList: E.hola_headers,
                socket: socket,
                agent: false,
                rejectUnauthorized: !_this.opt.insecure,
            });
            // XXX jesse remove duplication of this block
            if (response.request.body)
                proxy.write(response.request.body);
            req.pipe(proxy);
            req.on('end', req._onend = ()=>proxy.end());
            _this._log.info(
                `timeline-debug ${_res.headers['x-hola-timeline-debug']}`);
            yield handler(proxy, _res.headers);
            _etask.return();
        })).on('error', this.throw_fn()).end();
        return yield this.wait();
    }
    const proxy = _this.http.request({
        host: host,
        port: _this.opt.proxy_port,
        method: req.method,
        path: _url,
        agent: _this.protocol,
        headers: assign(connect_headers, headers),
        proxyHeaderWhiteList: E.hola_headers,
        proxyHeaderExclusiveList: E.hola_headers,
        rejectUnauthorized: !_this.opt.insecure,
    });
    if (_ssl)
    {
        proxy.on('close', ()=>{
            timeline.end = Date.now()-timeline.start;
            _this.emit('response', response);
        }).end();
    }
    else
    {
        // XXX jesse remove duplication of this block
        if (response.request.body)
            proxy.write(response.request.body);
        req.pipe(proxy);
        req.on('end', req._onend = ()=>proxy.end());
    }
    yield handler(proxy);
});

E.prototype.request = function(){
    const args = [].slice.call(arguments);
    if (typeof args[0]=='string')
        args[0] = {url: args[0]};
    args[0].proxy = args[0].proxy||`http://127.0.0.1:${this.port}`;
    return request.apply(null, args);
};
