// LICENSE_CODE ZON ISC
'use strict'; /*jslint node:true, esnext:true*/
const _ = require('lodash');

const boolean_part = {
    raw: true,
    direct: true,
};
const abbr = {
    cu: 'customer',
    z: 'zone',
    k: 'key',
    d: 'direct',
    s: 'session',
    to: 'timeout',
    dbg: 'debug',
    cy: 'country',
    st: 'state',
    ct: 'city',
};
const short = _.fromPairs(_.toPairs(abbr).map(x=>[x[1], x[0]]));

const parse = header=>{
    if (!header)
        return;
    let m = header.match(/^Basic (.*)/);
    if (!m)
        return;
    header = new Buffer(m[1], 'base64').toString('ascii');
    let cred = header.split(':');
    let auth = {};
    let parts = cred[0].split('-');
    while (parts.length)
    {
        let key = parts.shift();
        if (key=='lum')
            continue;
        if (abbr[key])
            key = abbr[key];
        auth[key] = boolean_part[key] || parts.shift();
    }
    auth.password = cred[1];
    return auth;
};

const calc = (opt, make_short)=>{
    const parts = ['lum'];
    for (let key in opt)
    {
        let val = opt[key], bool = boolean_part[key];
        if (!val || val=='*')
            continue;
        if (make_short && short[key])
            key = short[key];
        parts.push(key);
        if (!bool)
        {
            parts.push((''+val).toLowerCase()
                .replace(/ /g, make_short ? '' : '_'));
        }
    }
    return parts.join('-');
};

module.exports = {parse, calc};
