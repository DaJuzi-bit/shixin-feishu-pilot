export function isPrivateIpv4(value) {
  if(typeof value!=='string'||!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value))return false;
  const parts=value.split('.');
  if(parts.some(part=>String(Number(part))!==part||Number(part)>255))return false;
  const [first,second]=parts.map(Number);
  return first===10||first===172&&second>=16&&second<=31||first===192&&second===168;
}

function exactHost(req,authority) {
  if(typeof req.headers?.host!=='string'||req.headers.host!==authority)return false;
  if(req.rawHeaders){
    let count=0;
    for(let i=0;i<req.rawHeaders.length;i+=2)if(String(req.rawHeaders[i]).toLowerCase()==='host'){
      count++;if(req.rawHeaders[i+1]!==authority)return false;
    }
    if(count!==1)return false;
  }
  return true;
}

function peerAddress(req) {
  const peer=req.socket?.remoteAddress;
  return typeof peer==='string'&&peer.startsWith('::ffff:')?peer.slice(7):peer;
}

export function authorizeLanRequest(req,config) {
  if(!config.lanPreview)return true;
  if(!isPrivateIpv4(config.host)||config.lanAuthority!==config.host+':'+config.port||!exactHost(req,config.lanAuthority))return false;
  const peer=peerAddress(req);
  return peer==='127.0.0.1'||isPrivateIpv4(peer)&&(peer===config.host||config.lanClients?.includes(peer)===true);
}

export function createLoopbackRedirectHandler(config) {
  return (req,res)=>{
    if(peerAddress(req)!=='127.0.0.1'||!exactHost(req,'127.0.0.1:'+config.port)){
      res.writeHead(403,{'cache-control':'no-store'});res.end();return;
    }
    const path=req.url;
    let decoded;
    try{decoded=decodeURIComponent(path);}catch{}
    if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||typeof decoded!=='string'||/[\\\x00-\x20\x7f#]/.test(path)||/[\\\x00-\x1f\x7f]/.test(decoded)){
      res.writeHead(400,{'cache-control':'no-store'});res.end();return;
    }
    res.writeHead(302,{location:config.publicBaseUrl+path,'cache-control':'no-store'});res.end();
  };
}
