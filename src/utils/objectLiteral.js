/** Parse JSON-like JavaScript object literals without executing source code. */
function parseSafeObjectLiteral(source) {
    const text = String(source || '');
    let index = 0;
    const fail = (message) => { throw new Error(`${message} (位置 ${index})`); };
    const skip = () => {
        while (index < text.length) {
            if (/\s/.test(text[index])) { index += 1; continue; }
            if (text.startsWith('//', index)) {
                index = text.indexOf('\n', index + 2);
                if (index < 0) index = text.length;
                continue;
            }
            if (text.startsWith('/*', index)) {
                const end = text.indexOf('*/', index + 2);
                if (end < 0) fail('注释未闭合');
                index = end + 2;
                continue;
            }
            break;
        }
    };
    const string = () => {
        const quote = text[index++];
        let output = '';
        while (index < text.length) {
            const char = text[index++];
            if (char === quote) return output;
            if (char !== '\\') { output += char; continue; }
            if (index >= text.length) fail('字符串转义未闭合');
            const escaped = text[index++];
            const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
            if (simple[escaped] !== undefined) output += simple[escaped];
            else if (escaped === 'x') {
                const hex = text.slice(index, index + 2);
                if (!/^[0-9a-f]{2}$/i.test(hex)) fail('非法十六进制转义');
                output += String.fromCharCode(parseInt(hex, 16)); index += 2;
            } else if (escaped === 'u') {
                const hex = text.slice(index, index + 4);
                if (!/^[0-9a-f]{4}$/i.test(hex)) fail('非法 Unicode 转义');
                output += String.fromCharCode(parseInt(hex, 16)); index += 4;
            } else if (escaped === '\n') {
                // JavaScript line continuation
            } else output += escaped;
        }
        fail('字符串未闭合');
    };
    const identifier = () => {
        const match = /^[A-Za-z_$][\w$-]*/.exec(text.slice(index));
        if (!match) fail('期望标识符');
        index += match[0].length;
        return match[0];
    };
    const value = () => {
        skip();
        const char = text[index];
        if (char === '{') return object();
        if (char === '[') return array();
        if (char === '"' || char === "'") return string();
        const numberMatch = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i.exec(text.slice(index));
        if (numberMatch) { index += numberMatch[0].length; return Number(numberMatch[0]); }
        const word = identifier();
        if (word === 'true') return true;
        if (word === 'false') return false;
        if (word === 'null') return null;
        if (word === 'undefined') return undefined;
        fail(`不支持的表达式 ${word}`);
    };
    const object = () => {
        const output = {};
        index += 1;
        skip();
        while (text[index] !== '}') {
            if (index >= text.length) fail('对象未闭合');
            const key = text[index] === '"' || text[index] === "'" ? string() : identifier();
            skip();
            if (text[index++] !== ':') fail('对象字段缺少冒号');
            output[key] = value();
            skip();
            if (text[index] === ',') { index += 1; skip(); if (text[index] === '}') break; }
            else if (text[index] !== '}') fail('对象字段之间缺少逗号');
        }
        index += 1;
        return output;
    };
    const array = () => {
        const output = [];
        index += 1;
        skip();
        while (text[index] !== ']') {
            if (index >= text.length) fail('数组未闭合');
            output.push(value());
            skip();
            if (text[index] === ',') { index += 1; skip(); if (text[index] === ']') break; }
            else if (text[index] !== ']') fail('数组元素之间缺少逗号');
        }
        index += 1;
        return output;
    };

    const result = value();
    skip();
    if (index !== text.length) fail('对象后存在额外内容');
    return result;
}

module.exports = { parseSafeObjectLiteral };
