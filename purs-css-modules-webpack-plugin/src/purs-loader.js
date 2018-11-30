const fs = require("fs");
const path = require("path");

const pursLoader = require("purs-loader");
const R = require("ramda");

const pursLoaderUtils = require("purs-loader/utils");
const utils = require("./utils");

const libs = [/bower_components/, /\.psc-package/];

const extractCSSModulesImports = source => {
  const imports = [];

  let matchedCSSModuleImport;
  const matchCSSModuleImport = /^\s*(?<!--)\s*import\s*(((?:\w+\.)*\w+)\.CSS)/mg;
  while (matchedCSSModuleImport = matchCSSModuleImport.exec(source)) {
    const [, cssModuleName, ownerModuleName] = matchedCSSModuleImport;
    imports.push({ cssModuleName, ownerModuleName });
  }

  return R.uniqBy(R.prop('cssModuleName'), imports);
};

const withExtname = (ext, filename) =>
  path.join(path.dirname(filename),
    path.basename(filename, path.extname(filename)) + ext);

const findCSSModuleStyleSheet = ({ baseModulePath, baseModuleName, ownerModuleName }) => {
  const baseModuleDir = path.dirname(baseModulePath);
  const styleSheetName = path.basename(baseModulePath, path.extname(baseModulePath));
  return ownerModuleName === baseModuleName
    ? path.join(baseModuleDir, `${styleSheetName}.css`)
    : withExtname(".css", pursLoaderUtils.resolvePursModule({
        baseModulePath,
        baseModuleName,
        targetModuleName: ownerModuleName,
      }));
};

module.exports = function (source, ...rest) {
  if (this.cacheable) this.cacheable();

  if (libs.some(lib => lib.test(this.resourcePath))) {
    return pursLoader.call(this, source, ...rest);
  }

  const callback = this.async();

  if (!this.pursCSSModulesLocals) {
    return callback(utils.missingPluginErr);
  }

  this.async = () => callback;

  const matchModuleName = /\s*module\s+((?:\w+\.)*\w+)\s+where/;
  const [, pursModuleName] = matchModuleName.exec(source) || [];

  if (!pursModuleName) return pursLoader.call(this, source, ...rest);

  const imports = extractCSSModulesImports(source);
  Promise.all(imports.map(async ({ ownerModuleName }) => {
    const styleSheetPath = findCSSModuleStyleSheet({
      baseModulePath: this.resourcePath,
      baseModuleName: pursModuleName,
      ownerModuleName
    })

    this.addDependency(styleSheetPath);

    if (await utils.exists(styleSheetPath)) {
      const cssModuleDir = path.join(path.dirname(styleSheetPath),
        path.basename(styleSheetPath, path.extname(styleSheetPath)));

      await utils.writeCSSModule({
        dest: cssModuleDir,
        locals: await utils.loadCSSModule(this, styleSheetPath),
        stylesheetPath,
        ownerModuleName
      });

    } else {
      this.emitWarning(utils.missingStyleSheetErr({
        fromModuleName: pursModuleName,
        styleSheetPath: path.relative(this.rootContext, styleSheetPath)
      }));

      await utils.deleteCSSModule(cssModuleDir);
    }
  })).then(() => {
    const context = Object.preventExtensions(Object.assign(Object.create(this), {
      extractDependenciesOnError: error => {
        const [, pursModuleName] = pursLoaderUtils.matchErrModuleName.exec(error) || [];
        const [, pursModulePath] = pursLoaderUtils.matchErrLocation.exec(error) || [];

        const matchMissingCSSModuleName = /Module ((?:\w+\.)*\w+)\.CSS was not found/;
        const [, ownerModuleName] = matchMissingCSSModuleName.exec(error) || [];

        if (!pursModuleName || !pursModulePath || !ownerModuleName) return [];

        const styleSheetPath = findCSSModuleStyleSheet({
          baseModulePath: pursModulePath,
          baseModuleName: pursModuleName
          ownerModuleName
        });

        return [path.join(this.rootContext, styleSheetPath)];
      }
    }));

    pursLoader.call(context, source, ...rest);
  }, callback);
};
