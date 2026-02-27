const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Restrict Metro to the squint directory so it doesn't resolve
// modules from the parent project (which has "type": "module").
config.projectRoot = __dirname;
config.watchFolders = [__dirname];

module.exports = config;
