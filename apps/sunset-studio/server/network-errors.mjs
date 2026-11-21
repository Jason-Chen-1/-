export function requestErrorMessage(error){
 const codes=new Set(),seen=new Set();
 const visit=e=>{if(!e||typeof e!=='object'||seen.has(e))return;seen.add(e);if(e.code)codes.add(String(e.code));visit(e.cause);for(const nested of e.errors||[])visit(nested);};visit(error);
 const has=(...values)=>values.some(value=>codes.has(value));
 if(has('CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID'))return 'API 证书验证失败，请检查系统时间和代理证书配置。';
 if(has('ENOTFOUND','EAI_AGAIN'))return '无法解析 API 域名，请检查 API 地址、DNS 和代理设置。';
 if(error?.name==='TimeoutError'||has('UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','ETIMEDOUT'))return '连接 API 超时，请确认网络和代理可用，再重启本地服务重试。';
 if(has('ECONNREFUSED'))return 'API 或代理拒绝连接，请确认代理已启动、地址和端口正确，再重启本地服务。';
 if(error?.message==='fetch failed'||has('ECONNRESET','UND_ERR_SOCKET','ENETUNREACH','EHOSTUNREACH'))return '无法连接 API，请检查网络及 HTTP_PROXY / HTTPS_PROXY。Windows 会在启动时读取已启用的系统代理，修改后请重启本地服务。';
 return String(error?.message||'Request failed');
}
