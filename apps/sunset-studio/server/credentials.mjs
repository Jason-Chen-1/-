export function normalizeApiKey(raw,label='API Key'){
 const key=String(raw??'').trim();
 if(!key)throw new Error(`${label} 不能为空，请从服务商控制台重新复制。`);
 if(key.length>4096)throw new Error(`${label} 长度超出限制。`);
 if(/[^\x21-\x7e]|["'`]/.test(key))throw new Error(`${label} 包含中文、弯引号、空格或其他无效字符。请从服务商控制台重新复制完整 Key，不要附带引号或说明文字。`);
 return key;
}
