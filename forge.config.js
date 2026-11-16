const fs = require('fs');
const path = require('path');
const glob = require('glob');
const pkg = require("./package.json");

module.exports = {
  packagerConfig: {
    icon: 'assets/images/icon.ico', // Windows icon
    asar: {
      // @electron/asar expects one minimatch pattern string, not an array.
      // Brace expansion keeps the native modules and offline OCR/PDF assets unpacked.
      unpack: '**/{*.node,tesseract.js/**,tesseract.js-core/**,@tesseract.js-data/eng/**,@napi-rs/**,pdfjs-dist/**}'
    },
    ignore: [
      'gulpfile\\.js',
      '\\.git.*',
      'TODO',
      'notes\\.txt',
      'forge\\.config\\.js',
      'tests',
      'jest\\.config\\.js',
    ],
  },
  rebuildConfig: {},
  makers: [
    // Generic zip archive
    { name: '@electron-forge/maker-zip' },

    // Windows
    { name: '@electron-forge/maker-squirrel', config: {} },
    { name: '@electron-forge/maker-wix', config: { language: 1033, manufacturer: pkg.author } },

    // Linux
    { name: '@electron-forge/maker-deb', config: {} },
    { name: '@electron-forge/maker-rpm', config: {} },

    // macOS
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
  ],

  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'drkNsubuga',
          name: 'PharmaSpot',
          draft: true,
        },
      },
    },
  ],

  // Fix issue with packaging Linux apps (node_gyp_bins)
  hooks: {
    packageAfterPrune(config, buildPath) {
      if (process.platform === 'linux') {
        const dirs = glob.sync(
          path.join(buildPath, 'node_modules/**/node_gyp_bins'),
          {
            onlyDirectories: true,
          }
        );

        for (const directory of dirs) {
          fs.rmdirSync(directory, { recursive: true, force: true });
        }
      }
    },
  },
};
