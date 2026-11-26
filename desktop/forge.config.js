// How `npm run make` turns this folder into StudFlow-Setup.exe (specs/desktop-app.md).
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    name: 'StudFlow',
    executableName: 'StudFlow',
    icon: 'assets/icon',
    asar: true,
    // Only what the program runs: its compiled code, its icon and its one runtime package.
    ignore: (file) => file !== '' && !/^\/(package\.json$|dist(\/|$)|assets(\/|$)|node_modules(\/|$))/.test(file),
    win32metadata: {
      CompanyName: 'StudFlow',
      FileDescription: 'StudFlow billing and dispatch',
      ProductName: 'StudFlow',
      InternalName: 'StudFlow',
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: { name: 'studflow', setupExe: 'StudFlow-Setup.exe', setupIcon: 'assets/icon.ico', noMsi: true },
    },
  ],
  plugins: [
    // Burnt into the exe: it cannot run as plain Node, take NODE_OPTIONS or --inspect, or load
    // code from outside its checked archive; its cookies are encrypted by Windows.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};
