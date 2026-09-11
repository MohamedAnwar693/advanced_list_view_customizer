/** @odoo-module **/


const TOKEN_RE = /\s*(=>|<=|>=|==|!=|<>|[()+\-*/%<>?:]|[A-Za-z_][A-Za-z0-9_]*|\d+\.\d+|\d+)\s*/g;

class FormulaSyntaxError extends Error {}

function tokenize(formula) {
    const tokens = [];
    let lastIndex = 0;
    TOKEN_RE.lastIndex = 0;
    let match;
    while ((match = TOKEN_RE.exec(formula))) {
        if (match.index !== lastIndex) {
            throw new FormulaSyntaxError(`Unexpected character near "${formula.slice(lastIndex)}"`);
        }
        tokens.push(match[1]);
        lastIndex = TOKEN_RE.lastIndex;
    }
    if (lastIndex !== formula.length) {
        throw new FormulaSyntaxError(`Unexpected trailing characters: "${formula.slice(lastIndex)}"`);
    }
    return tokens;
}

function parse(tokens) {
    let pos = 0;

    function peek() {
        return tokens[pos];
    }
    function next() {
        return tokens[pos++];
    }
    function expect(tok) {
        if (peek() !== tok) {
            throw new FormulaSyntaxError(`Expected "${tok}" but found "${peek() ?? "end of formula"}"`);
        }
        return next();
    }
    function parseFactor() {
        const tok = peek();
        if (tok === undefined) {
            throw new FormulaSyntaxError("Unexpected end of formula");
        }
        if (tok === "-") {
            next();
            return { type: "neg", value: parseFactor() };
        }
        if (tok === "(") {
            next();
            const node = parseTernary();
            expect(")");
            return node;
        }
        if (/^\d/.test(tok)) {
            next();
            return { type: "num", value: parseFloat(tok) };
        }
        if (/^[A-Za-z_]/.test(tok)) {
            next();
            return { type: "field", name: tok };
        }
        throw new FormulaSyntaxError(`Unexpected token "${tok}"`);
    }
    function parseTerm() {
        let node = parseFactor();
        while (peek() === "*" || peek() === "/" || peek() === "%") {
            const op = next();
            node = { type: "binop", op, left: node, right: parseFactor() };
        }
        return node;
    }
    function parseAdditive() {
        let node = parseTerm();
        while (peek() === "+" || peek() === "-") {
            const op = next();
            node = { type: "binop", op, left: node, right: parseTerm() };
        }
        return node;
    }
    function parseComparison() {
        let node = parseAdditive();
        const cmpOps = ["<", ">", "<=", ">=", "==", "!=", "<>"];
        while (cmpOps.includes(peek())) {
            const op = next();
            node = { type: "cmp", op, left: node, right: parseAdditive() };
        }
        return node;
    }
    function parseTernary() {
        const cond = parseComparison();
        if (peek() === "?") {
            next();
            const whenTrue = parseTernary();
            expect(":");
            const whenFalse = parseTernary();
            return { type: "ternary", cond, whenTrue, whenFalse };
        }
        return cond;
    }
    const ast = parseTernary();
    if (pos !== tokens.length) {
        throw new FormulaSyntaxError(`Unexpected trailing token "${peek()}"`);
    }
    return ast;
}

function evaluateNode(node, context) {
    switch (node.type) {
        case "num":
            return node.value;
        case "field": {
            const raw = context[node.name];
            if (raw && typeof raw === "object" && "value" in raw) {
                // e.g. { id, display_name } for a many2one -> not numeric, treat as 0
                return 0;
            }
            const num = Number(raw);
            return Number.isFinite(num) ? num : 0;
        }
        case "neg":
            return -evaluateNode(node.value, context);
        case "binop": {
            const left = evaluateNode(node.left, context);
            const right = evaluateNode(node.right, context);
            switch (node.op) {
                case "+": return left + right;
                case "-": return left - right;
                case "*": return left * right;
                case "/": return right === 0 ? 0 : left / right;
                case "%": return right === 0 ? 0 : left % right;
            }
            break;
        }
        case "cmp": {
            const left = evaluateNode(node.left, context);
            const right = evaluateNode(node.right, context);
            switch (node.op) {
                case "<": return left < right;
                case ">": return left > right;
                case "<=": return left <= right;
                case ">=": return left >= right;
                case "==": return left === right;
                case "!=":
                case "<>": return left !== right;
            }
            break;
        }
        case "ternary":
            return evaluateNode(node.cond, context) ? evaluateNode(node.whenTrue, context) : evaluateNode(node.whenFalse, context);
        default:
            throw new FormulaSyntaxError(`Unknown node type "${node.type}"`);
    }
}

export function compileFormula(formula) {
    const tokens = tokenize(formula);
    const ast = parse(tokens);
    return (fieldValues) => {
        try {
            return evaluateNode(ast, fieldValues || {});
        } catch {
            return 0;
        }
    };
}

export { FormulaSyntaxError };
