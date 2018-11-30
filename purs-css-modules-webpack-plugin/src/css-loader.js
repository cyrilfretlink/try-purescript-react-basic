const cssLoader = require("css-loader");
const { getOptions } = require("loader-utils");

const R = require("ramda");

const { missingPluginErr } = require("./utils");

const invalidModulesOptionErr = new Error(`
CSS Loader "modules" option must be enabled in order to extract local class names from CSS files
`.trimLeft());

const parseCssModuleLocals = content => {
  const match = content.match(/exports\.locals\s*=\s*([^;]+)/);
  return match && JSON.parse(match[1]);
};

module.exports = function () {
  if (this.cacheable) this.cacheable();

  const callback = this.async();
  const options = getOptions(this)

  if (!this.pursCssModulesLocals) {
    return callback(missingPluginErr);
  }

  if (!options.modules) {
    return callback(invalidModulesOptionErr);
  }

  this.async = () => (err, content) => {
    if (err) return callback(err);

    try {
      this.pursCssModulesLocals.set(this.resourcePath,
        parseCssModuleLocals(content) || {});
    } catch (parseErr) {
      return callback(parseErr);
    }

    callback(null, content);
  };

  cssLoader.apply(this, arguments);
};
