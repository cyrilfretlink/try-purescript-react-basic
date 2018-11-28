const cssLoader = require("css-loader");
const utils = require("loader-utils");
const R = require("ramda");

const parseCSSModuleLocals = content => {
  const match = content.match(/exports\.locals\s*=\s*([^;]+)/);
  return match && JSON.parse(match[1]);
};

// See https://hackage.haskell.org/package/purescript-0.12.0/docs/src/Language.PureScript.Parser.Lexer.html#local-6989586621679252668
const matchValidPsName = /^([a-z]|_)(\w|_)*$/;

const and = words => {
  switch (words.length) {
    case 0: return "";
    case 1: return words[0];
    default:
      return `${R.init(words).join(", ")} and ${R.last(words)}`;
  }
};

const quote = R.map(word => `"${word}"`);

const missingPluginErr = new Error(`
This loader must be used with its corresponding plugin
`.trimLeft());

const invalidModulesOptionErr = new Error(`
CSS Loader "modules" option must be enabled in order to extract local class names from CSS files
`.trimLeft());

const invalidCamelCaseOptionMsg = value => `
  CSS Loader "camelCase" option should be set to "only" (was ${JSON.stringify(value)}) in order to sanitize otherwise invalid class names
`;

const invalidNamesErr = names => new Error(`
Invalid CSS class names ${and(quote(names))}

  This plugin generates PureScript code from these CSS classes.
  Valid PureScript names consist of an underscore or a lower-case alphabetic Unicode character followed by many underscores or alphanumeric Unicode characters.
`.trimLeft());

module.exports = function () {
  if (this.cacheable) this.cacheable();

  const callback = this.async();
  const options = utils.getOptions(this)

  if (!options.modules) {
    return callback(invalidModulesOptionErr);
  }

  if (!this.pursCSSModulesLocals) {
    return callback(missingPluginErr);
  }

  if (options.camelCase !== "only") {
    this.emitWarningOnce(invalidCamelCaseOptionMsg(options.camelCase));
  }

  this.async = () => (err, content) => {
    if (err) return callback(err);

    const locals = parseCSSModuleLocals(content) || {};
    const names = Object.keys(locals);

    const invalids = names.filter(name => !matchValidPsName.test(name));
    if (invalids.length) return callback(invalidNamesErr(invalids));

    this.pursCSSModulesLocals.set(this.resourcePath, locals);
    callback(null, content);
  };

  cssLoader.apply(this, arguments);
};
