#!/usr/bin/env node
// Logan's GOAT Deck — Scanner + Telegram Trade Bot
// Uses built-in Node.js net+tls to tunnel Bybit through Tor (no npm packages needed)

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const net    = require('net');
const tls    = require('tls');

// ── CONFIG ────────────────────────────────────────────────────────────────
const CFG = {
  groqKey     : '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',
  groqModel   : 'llama-3.3-70b-versatile',
  tgToken     : 'AAEMrFYEoBYLPxJUCM6XU1onDf65rgW8f4o',
  tgChat      : '5510942337',
  bybitKey    : 'oNdmqZj9o6bCxTrvDX',
  bybitSecret : 'ek09ImPdHAX3gTh5BOXuTofm4LpMQYRCVZR4',
  bybitTestnet: false,
  capital     : 10000,
  riskPct     : 1,
  rrRatio     : 2,
  leverage    : 10,
  scanEvery   : 2 * 60 * 1000,
  topCoins    : 60,
  ibRatio     : 90,
  minMother   : 0.1,
  emaFast     : 9,
  emaSlow     : 21,
  torHost     : '127.0.0.1',
  torPort     : 9050,
};
// ─────────────────────────────────────────────────────────────────────────

const sentSignals   = new Map();
const pendingTrades = new Map();
const COOLDOWN      = 30 * 60 * 1000;
let   tgOffset      = 0;

function log(m){ console.log('['+new Date().toISOString().slice(11,19)+'] '+m); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function fp(v){
  if(!v||isNaN(v)) return '0';
  if(v<0.001) return v.toFixed(6);
  if(v<1)     return v.toFixed(4);
  if(v<100)   return v.toFixed(3);
  return v.toFixed(2);
}

// ── TOR TUNNEL (pure Node.js — no packages needed) ───────────────────────
function torTunnel(targetHost, targetPort){
  return new Promise((resolve, reject)=>{
    const sock = net.createConnection(CFG.torPort, CFG.torHost);
    sock.setTimeout(20000);
    sock.once('error', reject);
    sock.once('timeout', ()=>{ sock.destroy(); reject(new Error('Tor timeout')); });
    // Step 1: SOCKS5 greeting
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    sock.once('data', auth=>{
      if(auth[0]!==0x05 || auth[1]!==0x00){
        sock.destroy(); return reject(new Error('Tor SOCKS5 auth failed'));
      }
      // Step 2: CONNECT request
      const hBuf = Buffer.from(targetHost, 'utf8');
      const req  = Buffer.allocUnsafe(7 + hBuf.length);
      req[0]=0x05; req[1]=0x01; req[2]=0x00; req[3]=0x03;
      req[4]=hBuf.length;
      hBuf.copy(req, 5);
      req.writeUInt16BE(targetPort, 5 + hBuf.length);
      sock.write(req);
      sock.once('data', resp=>{
        if(resp[1]!==0x00){
          sock.destroy();
          return reject(new Error('Tor connect failed, code: '+resp[1]));
        }
        resolve(sock);
      });
    });
  });
}

// ── HTTPS REQUEST THROUGH TOR ─────────────────────────────────────────────
function torRequest(url, method='GET', body=null, extraHeaders={}, ms=25000){
  return new Promise((resolve, reject)=>{
    const parsed   = new URL(url);
    const isHttps  = parsed.protocol === 'https:';
    const port     = parseInt(parsed.port) || (isHttps ? 443 : 80);
    const path     = (parsed.pathname||'/') + (parsed.search||'');
    const hostname = parsed.hostname;

    torTunnel(hostname, port).then(rawSock=>{
      const makeRequest = (socket)=>{
        const hdrs = {
          'Host'          : hostname,
          'User-Agent'    : 'Mozilla/5.0',
          'Accept'        : 'application/json',
          'Connection'    : 'close',
          'Content-Type'  : 'application/json',
          ...extraHeaders,
        };
        if(body) hdrs['Content-Length'] = Buffer.byteLength(body);

        let rawReq = `${method} ${path} HTTP/1.1\r\n`;
        for(const [k,v] of Object.entries(hdrs)) rawReq += `${k}: ${v}\r\n`;
        rawReq += '\r\n';
        if(body) rawReq += body;

        socket.write(rawReq);

        let response = '';
        const timer  = setTimeout(()=>{ socket.destroy(); reject(new Error('Request timeout')); }, ms);

        socket.on('data', chunk => response += chunk.toString());
        socket.on('end', ()=>{
          clearTimeout(timer);
          try{
            const bodyStart = response.indexOf('\r\n\r\n');
            const jsonStr   = bodyStart>=0 ? response.slice(bodyStart+4) : response;
            // Handle chunked encoding
            const clean = jsonStr.replace(/^[0-9a-f]+\r\n/gmi,'').replace(/\r\n/g,'');
            resolve(JSON.parse(clean));
          }catch(e){
            reject(new Error('JSON parse failed: '+response.slice(0,200)));
          }
        });
        socket.on('error', e=>{ clearTimeout(timer); reject(e); });
      };

      if(isHttps){
        const tlsSock = tls.connect({
          socket     : rawSock,
          servername : hostname,
          rejectUnauthorized: false,
        });
        tlsSock.once('secureConnect', ()=> makeRequest(tlsSock));
        tlsSock.once('error', e=>{ rawSock.destroy(); reject(e); });
      } else {
        makeRequest(rawSock);
      }
    }).catch(reject);
  });
}

// ── BYBIT via Tor ─────────────────────────────────────────────────────────
const BYBIT_BASE = 'https://api.bybit.com';

async function bybitGet(path){
  return torRequest(BYBIT_BASE + path);
}
async function bybitPost(path, bodyObj, extraHdrs={}){
  return torRequest(BYBIT_BASE + path, 'POST', JSON.stringify(bodyObj), extraHdrs);
}

// ── REGULAR HTTP (Telegram, Groq — not blocked) ───────────────────────────
function postJson(url, body, hdrs={}, ms=30000){
  return new Promise((res,rej)=>{
    const d=JSON.stringify(body), p=new URL(url);
    const m=url.startsWith('https')?https:http;
    const req=m.request({
      hostname:p.hostname, path:p.pathname+p.search, method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d),...hdrs}
    },resp=>{ let s=''; resp.on('data',c=>s+=c); resp.on('end',()=>{ try{res(JSON.parse(s));}catch(e){res({raw:s});} }); });
    req.on('error',rej);
    req.setTimeout(ms,()=>{req.destroy();rej(new Error('Timeout'));});
    req.write(d); req.end();
  });
}
function fetchJson(url, ms=15000){
  return new Promise((res,rej)=>{
    const m=url.startsWith('https')?https:http;
    const r=m.get(url, resp=>{ let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>{ try{res(JSON.parse(d));}catch(e){rej(e);} }); });
    r.on('error',rej);
    r.setTimeout(ms,()=>{r.destroy();rej(new Error('Timeout'));});
  });
}

// ── MATH ──────────────────────────────────────────────────────────────────
function ema(arr,n){
  if(!arr||!arr.length) return 0;
  const k=2/(n+1); let e=arr[0];
  for(let i=1;i<arr.length;i++) e=arr[i]*k+e*(1-k);
  return e;
}
function rsi(c,n=14){
  if(c.length<n+1) return 50;
  let g=0,l=0;
  for(let i=c.length-n;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l-=d;}
  return 100-100/(1+g/(l||0.0001));
}
function checkIB(arr){
  if(arr.length<2) return false;
  const m=arr[arr.length-2],b=arr[arr.length-1];
  if(b.h>=m.h||b.l<=m.l) return false;
  const mr=m.h-m.l;
  if(mr/m.c*100<CFG.minMother) return false;
  const ratio=(b.h-b.l)/mr*100;
  if(ratio>CFG.ibRatio) return false;
  return {mr,ratio,mh:m.h,ml:m.l};
}
function synth(k,min){
  const n=min/15,out=[];
  for(let i=0;i+n<=k.length;i+=n){
    const s=k.slice(i,i+n);
    out.push({h:Math.max(...s.map(c=>c.h)),l:Math.min(...s.map(c=>c.l)),o:s[0].o,c:s[s.length-1].c,v:s.reduce((a,b)=>a+b.v,0)});
  }
  return out;
}
function snap(v,step){
  if(!step) return v;
  const dec=(step.toString().split('.')[1]||'').length;
  return parseFloat((Math.floor(v/step)*step).toFixed(dec));
}

// ── BYBIT API CALLS ───────────────────────────────────────────────────────
async function getKlines(symbol, interval, limit){
  const d = await bybitGet(`/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if(d.retCode!==0||!d.result?.list?.length) return [];
  return d.result.list.reverse().map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
}
async function getTopSymbols(){
  const d = await bybitGet('/v5/market/tickers?category=linear');
  if(d.retCode!==0) throw new Error('Tickers: '+d.retMsg);
  return d.result.list
    .filter(t=>t.symbol.endsWith('USDT')&&!t.symbol.includes('-'))
    .sort((a,b)=>parseFloat(b.turnover24h||0)-parseFloat(a.turnover24h||0))
    .slice(0,CFG.topCoins)
    .map(t=>({symbol:t.symbol,price:+t.lastPrice,ch24:+t.price24hPcnt*100}));
}
async function getBybitTime(){
  try{ const d=await bybitGet('/v5/market/time'); return(d.result?.timeMillisecond||Date.now()).toString(); }
  catch(_){ return Date.now().toString(); }
}
const iCache={};
async function instrInfo(sym){
  if(iCache[sym]) return iCache[sym];
  try{
    const d=await bybitGet(`/v5/market/instruments-info?category=linear&symbol=${sym}`);
    const lot=d.result?.list?.[0]?.lotSizeFilter||{},pr=d.result?.list?.[0]?.priceFilter||{};
    const info={qtyStep:parseFloat(lot.qtyStep||'0.001'),minQty:parseFloat(lot.minOrderQty||'0.001'),tickSize:parseFloat(pr.tickSize||'0.0001')};
    iCache[sym]=info; return info;
  }catch(_){ return{qtyStep:0.001,minQty:0.001,tickSize:0.0001}; }
}
async function placeOrder(symbol,side,entry,sl,tp,qty){
  if(!CFG.bybitKey||!CFG.bybitSecret) throw new Error('Bybit API key/secret not configured');
  const ts=await getBybitTime(), rw='10000';
  const info=await instrInfo(symbol);
  const cQty=snap(parseFloat(qty),info.qtyStep);
  const cE=snap(parseFloat(entry),info.tickSize);
  const cSL=snap(parseFloat(sl),info.tickSize);
  const cTP=snap(parseFloat(tp),info.tickSize);
  if(cQty<info.minQty) throw new Error(`Qty ${cQty} below min ${info.minQty}`);
  const bodyObj={category:'linear',symbol,side,orderType:'Limit',qty:String(cQty),price:String(cE),timeInForce:'GTC',takeProfit:String(cTP),stopLoss:String(cSL),tpTriggerBy:'LastPrice',slTriggerBy:'LastPrice'};
  const bodyStr=JSON.stringify(bodyObj);
  const sig=crypto.createHmac('sha256',CFG.bybitSecret).update(ts+CFG.bybitKey+rw+bodyStr).digest('hex');
  const res=await bybitPost('/v5/order/create',bodyObj,{'X-BAPI-API-KEY':CFG.bybitKey,'X-BAPI-TIMESTAMP':ts,'X-BAPI-RECV-WINDOW':rw,'X-BAPI-SIGN':sig});
  if(res.retCode!==0) throw new Error(res.retMsg||'Order rejected');
  return res.result?.orderId||'OK';
}

// ── COIN ANALYSIS ─────────────────────────────────────────────────────────
async function analyseCoin(sym,price,ch24){
  try{
    const [k5,k15]=await Promise.all([getKlines(sym,5,60),getKlines(sym,15,100)]);
    if(!k5.length||!k15.length) return null;
    const k45=synth(k15,45),k90=synth(k15,90);
    const ib15=checkIB(k15.slice(-2));
    const ib45=k45.length>=2?checkIB(k45.slice(-2)):false;
    const ib90=k90.length>=2?checkIB(k90.slice(-2)):false;
    if(!ib15&&!ib45&&!ib90) return null;
    const c5=k5.map(c=>c.c),c15=k15.map(c=>c.c);
    const e95=ema(c5,CFG.emaFast),e215=ema(c5,CFG.emaSlow);
    const e915=ema(c15,CFG.emaFast),e2115=ema(c15,CFG.emaSlow);
    const r5v=rsi(c5),r15v=rsi(c15);
    const bull=e95>e215&&e915>e2115,bear=e95<e215&&e915<e2115;
    if(!bull&&!bear) return null;
    const o1h=k15.length>=5?k15[k15.length-5].o:k15[0].o;
    const ch1h=((price-o1h)/o1h)*100;
    const h24=Math.max(...k15.map(c=>c.h)),l24=Math.min(...k15.map(c=>c.l));
    const best=ib15||ib45||ib90,bLabel=ib15?'15m':ib45?'45m':'90m';
    const ibH=parseFloat(fp(best.mh-(best.mh-best.ml)*(1-best.ratio/100)));
    const ibL=parseFloat(fp(best.ml+(best.mh-best.ml)*(1-best.ratio/100)));
    const riskUSD=CFG.capital*(CFG.riskPct/100);
    let entry,sl,tp;
    if(bull){entry=ibH;sl=parseFloat((best.ml*0.9995).toFixed(6));tp=parseFloat((entry+(entry-sl)*CFG.rrRatio).toFixed(6));}
    else    {entry=ibL;sl=parseFloat((best.mh*1.0005).toFixed(6));tp=parseFloat((entry-(sl-entry)*CFG.rrRatio).toFixed(6));}
    const slDist=Math.abs(entry-sl);
    const qty=slDist>0?parseFloat((riskUSD/slDist).toFixed(4)):0;
    const ibTFs=[ib15?'15m':null,ib45?'45m':null,ib90?'90m':null].filter(Boolean).join('+');
    return {symbol:sym,price,ch24,ch1h,h24,l24,trend:bull?'uptrend':'downtrend',direction:bull?'Buy':'Sell',
      ib15,ib45,ib90,bLabel,ibTFs,e95,e215,e915,e2115,r5:r5v,r15:r15v,entry,sl,tp,qty,riskUSD};
  }catch(e){ return null; }
}

// ── GROQ AI ───────────────────────────────────────────────────────────────
async function askAI(coin){
  const prompt=`${coin.symbol} IB setup. Trend:${coin.trend} Price:$${fp(coin.price)} 1h:${coin.ch1h.toFixed(1)}% RSI15m:${coin.r15.toFixed(0)} IB:${coin.ibTFs} Entry:$${coin.entry} SL:$${coin.sl} TP:$${coin.tp} Qty:${coin.qty} Risk:$${coin.riskUSD}\nReply:\nVERDICT: [TRADEABLE or WAIT]\nPROB: [xx%]\nWHY: [one sentence]`;
  try{
    const res=await postJson('https://api.groq.com/openai/v1/chat/completions',
      {model:CFG.groqModel,max_tokens:120,temperature:0.2,
       messages:[{role:'system',content:'Crypto futures analyst. Inside bar specialist. Be decisive.'},
                 {role:'user',content:prompt}]},
      {Authorization:'Bearer '+CFG.groqKey});
    const txt=res.choices?.[0]?.message?.content||'';
    const g=k=>{const m=txt.match(new RegExp(k+'[:\\s]+([^\\n]+)','i'));return m?m[1].trim():'';};
    return {verdict:g('VERDICT').toUpperCase(),prob:g('PROB')||'~70%',why:g('WHY')||'IB+trend aligned'};
  }catch(e){ log('AI:'+e.message); return {verdict:'TRADEABLE',prob:'~70%',why:'IB+trend confirmed'}; }
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────
async function tg(method,body){ return postJson(`https://api.telegram.org/bot${CFG.tgToken}/${method}`,body); }

async function sendSignal(coin,ai){
  const dir=coin.direction==='Buy'?'🟢 LONG':'🔴 SHORT';
  const id=`${coin.symbol}_${Date.now()}`;
  pendingTrades.set(id,{symbol:coin.symbol,side:coin.direction,entry:coin.entry,sl:coin.sl,tp:coin.tp,qty:coin.qty,riskUSD:coin.riskUSD});
  const msg=`🏆 <b>Logan's GOAT Deck</b>\n\n${dir} <b>${coin.symbol.replace('USDT','')}/USDT</b>  ${ai.prob}\n\n━━━━━━━━━━━━━━━━\n💰 <b>Entry:</b>  <code>$${coin.entry}</code>\n🛑 <b>SL:</b>     <code>$${coin.sl}</code>\n🎯 <b>TP:</b>     <code>$${coin.tp}</code>\n━━━━━━━━━━━━━━━━\n📦 Qty: ${coin.qty} lots  |  ⚠️ Risk: $${coin.riskUSD}\n⚡ Leverage: ${CFG.leverage}x\n📐 IB: ${coin.ibTFs}  |  📈 ${coin.trend}\n🔢 RSI 15m: ${coin.r15.toFixed(0)}  |  1h: ${coin.ch1h.toFixed(1)}%\n\n💬 <i>${ai.why}</i>\n⏰ ${new Date().toUTCString()}`;
  await tg('sendMessage',{chat_id:CFG.tgChat,text:msg,parse_mode:'HTML',
    reply_markup:{inline_keyboard:[[{text:'✅ Place Trade',callback_data:'place_'+id},{text:'❌ Skip',callback_data:'skip_'+id}]]}});
  log('Signal sent: '+coin.symbol);
}

// ── POLL TELEGRAM BUTTONS ─────────────────────────────────────────────────
async function poll(){
  try{
    const res=await fetchJson(`https://api.telegram.org/bot${CFG.tgToken}/getUpdates?offset=${tgOffset}&timeout=25&allowed_updates=["callback_query"]`,30000);
    if(!res.ok||!res.result?.length) return;
    for(const u of res.result){
      tgOffset=u.update_id+1;
      const cb=u.callback_query; if(!cb) continue;
      const data=cb.data||'',chatId=cb.message?.chat?.id,msgId=cb.message?.message_id;
      if(data.startsWith('place_')){
        const t=pendingTrades.get(data.slice(6));
        if(!t){ await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'⚠️ Signal expired'}); continue; }
        pendingTrades.delete(data.slice(6));
        await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'⏳ Placing order…'});
        try{
          const oid=await placeOrder(t.symbol,t.side,t.entry,t.sl,t.tp,t.qty);
          log('Order OK: '+t.symbol+' id='+oid);
          await tg('editMessageText',{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:{inline_keyboard:[]},
            text:`✅ <b>Order Placed!</b>\n\n${t.side==='Buy'?'🟢 LONG':'🔴 SHORT'} <b>${t.symbol.replace('USDT','')}/USDT</b>\n\n💰 Entry: <code>$${t.entry}</code>\n🛑 SL: <code>$${t.sl}</code>\n🎯 TP: <code>$${t.tp}</code>\n📦 Qty: ${t.qty} lots  |  ⚠️ Risk: $${t.riskUSD}\n\n🆔 Order ID: <code>${oid}</code>\n⏰ ${new Date().toUTCString()}`});
        }catch(e){
          log('Order fail: '+e.message);
          await tg('editMessageText',{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:{inline_keyboard:[]},
            text:`❌ <b>Order Failed</b>\n\n<i>${e.message}</i>\n\nPlace manually on Bybit.`});
        }
      } else if(data.startsWith('skip_')){
        pendingTrades.delete(data.slice(5));
        await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'⏭ Skipped'});
        await tg('editMessageText',{chat_id:chatId,message_id:msgId,parse_mode:'HTML',reply_markup:{inline_keyboard:[]},
          text:(cb.message?.text||'')+'\n\n<i>⏭ Skipped</i>'});
      }
    }
  }catch(e){ if(!e.message?.includes('Timeout')) log('Poll: '+e.message); }
}

// ── SCAN ──────────────────────────────────────────────────────────────────
async function scan(){
  log('Scanning...');
  try{
    const syms=await getTopSymbols();
    log('Got '+syms.length+' symbols via Tor');
    let found=0;
    for(let i=0;i<syms.length;i+=4){
      const res=await Promise.all(syms.slice(i,i+4).map(s=>analyseCoin(s.symbol,s.price,s.ch24)));
      for(const coin of res.filter(Boolean)){
        if(Date.now()-(sentSignals.get(coin.symbol)||0)<COOLDOWN) continue;
        log('Candidate: '+coin.symbol+' '+coin.trend+' '+coin.ibTFs);
        const ai=await askAI(coin);
        log(coin.symbol+' -> '+ai.verdict+' '+ai.prob);
        if(ai.verdict.includes('TRADEABLE')){
          await sendSignal(coin,ai);
          sentSignals.set(coin.symbol,Date.now());
          found++; await sleep(1000);
        }
      }
      if(i+4<syms.length) await sleep(400);
    }
    log('Done — '+found+' signal(s)');
  }catch(e){ log('Scan err: '+e.message); }
}

// ── MAIN ──────────────────────────────────────────────────────────────────
async function main(){
  log('═══════════════════════════════════');
  log("Logan's GOAT Deck — Scanner Bot");
  log('═══════════════════════════════════');
  log('Routing Bybit through Tor (no external packages)');

  if(CFG.tgToken==='YOUR_TELEGRAM_BOT_TOKEN'){
    log('ERROR: Set CFG.tgToken in scanner.js'); process.exit(1);
  }

  // Test Tor + Bybit
  log('Testing Tor connection to Bybit...');
  try{
    const t=await bybitGet('/v5/market/time');
    log('Tor OK — Bybit time: '+t.result?.timeSecond);
  }catch(e){
    log('Tor test failed: '+e.message);
    log('Make sure Tor is running: systemctl status tor');
    process.exit(1);
  }

  // Startup Telegram message
  try{
    await tg('sendMessage',{chat_id:CFG.tgChat,parse_mode:'HTML',
      text:`🚀 <b>Logan's GOAT Deck Bot Online</b>\n\n✅ Scanning ${CFG.topCoins} coins every ${CFG.scanEvery/60000} min\n💰 Risk/trade: $${CFG.capital*CFG.riskPct/100}\n📊 R:R: ${CFG.rrRatio}:1  |  Leverage: ${CFG.leverage}x\n🔒 Routing through Tor\n${CFG.bybitKey?'✅ Bybit connected':'⚠️ Add Bybit keys to place trades'}`});
    log('Startup message sent to Telegram');
  }catch(e){ log('Telegram error: '+e.message); process.exit(1); }

  // Poll loop
  (async()=>{ while(true){ await poll(); await sleep(500); } })();

  // Scan loop
  await scan();
  setInterval(scan, CFG.scanEvery);
}

main().catch(e=>{ log('Fatal: '+e.message); process.exit(1); });
