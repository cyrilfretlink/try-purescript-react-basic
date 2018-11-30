const fs = require("fs");
const path = require("path");

const pursLoader = require("purs-loader");
const R = require("ramda");

const pursLoaderUtils = require("purs-loader/utils");
const utils = require("./utils");

const libs = [/bower_components/, /\.psc-package/];

const extractCssModulesImports = source => {
  const imports = [];

  let matchedCssModuleImport;
  const matchCssModuleImport = /^\s*(?<!--)\s*import\s*((?:\w+\.)*\w+)\.CSS/mg;
  while (matchedCssModuleImport = matchCssModuleImport.exec(source)) {
    const [, namespace] = matchedCssModuleImport;
    imports.push({ namespace });
  }

  return R.uniqBy(R.prop('namespace'), imports);
};

const withExtname = (ext, filename) =>
  path.join(path.dirname(filename),
    path.basename(filename, path.extname(filename)) + ext);

const findCssModuleStyleSheet = ({ baseModulePath, baseModuleName, namespace }) => {
  const baseModuleDir = path.dirname(baseModulePath);
  const styleSheetName = path.basename(baseModulePath, path.extname(baseModulePath));
  return namespace === baseModuleName
    ? path.join(baseModuleDir, `${styleSheetName}.css`)
    : withExtname(".css", pursLoaderUtils.resolvePursModule({
        baseModulePath,
        baseModuleName,
        targetModuleName: namespace,
      }));
};

const findCssModuleRoot = styleSheetPath =>
  path.join(path.dirname(styleSheetPath),
    path.basename(styleSheetPath, path.extname(styleSheetPath)));

module.exports = function (source, ...rest) {
  if (this.cacheable) this.cacheable();

  if (libs.some(lib => lib.test(this.resourcePath))) {
    return pursLoader.call(this, source, ...rest);
  }

  const callback = this.async();

  if (!this.pursCssModulesLocals) {
    return callback(utils.missingPluginErr);
  }

  this.async = () => callback;

  const matchModuleName = /\s*module\s+((?:\w+\.)*\w+)\s+where/;
  const [, pursModuleName] = matchModuleName.exec(source) || [];

  if (!pursModuleName) return pursLoader.call(this, source, ...rest);

  const imports = extractCssModulesImports(source);
  Promise.all(imports.map(({ namespace }) => {
    const styleSheetPath = findCssModuleStyleSheet({
      baseModulePath: this.resourcePath,
      baseModuleName: pursModuleName,
      namespace
    })

    this.addDependency(styleSheetPath);

    return utils.reifyCssModule(this, {
      name: pursModuleName,
      cssModule: {
        root: findCssModuleRoot(styleSheetPath),
        styleSheetPath,
        namespace
      }
    }, this.emitWarning);
  })).then(() => {
    const context = Object.preventExtensions(Object.assign(Object.create(this), {
      describePscError: (error, desc) => {
        const matchMissingCssModuleName = /Module ((?:\w+\.)*\w+)\.CSS was not found/;
        const [, namespace] = matchMissingCssModuleName.exec(error) || [];

        if (!namespace) return {};

        const styleSheetPath = findCssModuleStyleSheet({
          baseModulePath: desc.filename,
          baseModuleName: desc.name
          namespace
        });

        return {
          dependencies: [path.join(this.rootContext, styleSheetPath)],
          details: {
            cssModule: {
              root: findCssModuleRoot(styleSheetPath),
              namespace,
              stylesheetPath
            }
          }
        };
      }
    }));

    pursLoader.call(context, source, ...rest);
  }, callback);
};
