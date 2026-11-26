// electron-squirrel-startup ships no types: true when Squirrel started the exe only to make or
// remove its shortcuts, and the program should quit at once.
declare module 'electron-squirrel-startup' {
  const started: boolean;
  export = started;
}
