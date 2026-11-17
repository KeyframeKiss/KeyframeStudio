// Launch Electron with a clean environment. When started from a VS Code terminal,
// ELECTRON_RUN_AS_NODE=1 is inherited and Electron would run as plain Node (no window).
const { spawn } = require('child_process');
const path = require('path');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env, cwd: path.join(__dirname, '..') });
child.on('exit', (code) => process.exit(code ?? 0));
