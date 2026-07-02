export function isCodexJsonRpcResponse(message) {
    return Object.prototype.hasOwnProperty.call(message, 'id')
        && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'));
}
export function isCodexJsonRpcNotification(message) {
    return Object.prototype.hasOwnProperty.call(message, 'method')
        && !Object.prototype.hasOwnProperty.call(message, 'id');
}
//# sourceMappingURL=codex-app-server-protocol.js.map