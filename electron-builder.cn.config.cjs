const { CHINA_EDITION } = require('./scripts/release/edition')

module.exports = function createChinaEditionConfig() {
  return {
    extends: './electron-builder.yml',
    appId: 'io.github.torirr.TinyCherry.cn',
    extraMetadata: {
      cherryEdition: CHINA_EDITION
    }
  }
}
