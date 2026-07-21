// server.js - Proxy de WebSocket para o Stockfish Local
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const wss = new WebSocketServer({ port: 8081 });

console.log("[Servidor] Rodando na porta 8080. Aguardando conexão do Fantasma...");

wss.on('connection', (ws) => {
    console.log("[Servidor] Conexão Fantasma estabelecida!");
    
    // Inicia o processo nativo do Stockfish local
    const engine = spawn('./stockfish.exe'); // Troque para './stockfish' se for Mac/Linux

    // O que o Stockfish disser, mandamos direto para o navegador
    engine.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.trim().length > 0 && ws.readyState === ws.OPEN) {
                ws.send(line);
            }
        });
    });

    // O que o navegador pedir (FEN), mandamos direto para o Stockfish
    ws.on('message', (message) => {
        const cmd = message.toString();
        engine.stdin.write(cmd + '\n');
    });

    ws.on('close', () => {
        console.log("[Servidor] Conexão Fantasma encerrada.");
        engine.kill();
    });
});