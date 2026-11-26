import { contextBridge, ipcRenderer } from 'electron';

// The whole bridge between the site and the PC: two calls, no arguments. The program decides
// the paper from the page's own address and checks who is calling (main.ts, "Printing").
// src/lib/desktop.ts finds it on the page; a browser has none.
contextBridge.exposeInMainWorld('studflowDesktop', {
  print: (): Promise<unknown> => ipcRenderer.invoke('studflow:print'),
  choosePrinter: (): Promise<unknown> => ipcRenderer.invoke('studflow:choose-printer'),
});
