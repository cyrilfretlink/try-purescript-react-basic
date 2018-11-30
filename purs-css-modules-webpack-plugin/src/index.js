const fs = require("fs");
const path = require("path");

const R = require("ramda");
const webpack = require("webpack");

const pursLoaderUtils = require("purs-loader/utils");
const utils = require("./utils");

const extractMissingCssModuleErrors = R.compose(
  R.filter(R.has("cssModule")),
  moduleErr =>
    moduleErr ? moduleErr.error.modules : [],
  R.find(moduleErr =>
    R.is(pursLoaderUtils.PscError, moduleErr.error)));

const catchRebuildErrors = f => stats =>
  f(stats).catch(error => {
    if (!stats.compilation.errors.includes(error)) {
      stats.compilation.errors.push(error);
    }
  });

const createNormalModule = (compilation, filename) => {
  const entry = webpack.SingleEntryPlugin.createDependency(filename);
  const factory = compilation.dependencyFactories.get(entry.constructor);
  return new Promise((resolve, reject) => {
    factory.create({ dependencies: [entry] }, (err, module) => {
      if (err) reject(err);
      else resolve(module);
    });
  });
};

const loadCssModule = (compilation, filename) =>
  createNormalModule(compilation, filename).then(module => {
    const loaderContext = module.createLoaderContext(
      compilation.resolverFactory
        .get("normal", module.resolveOptions),
      compilation.options,
      compilation,
      compilation.inputFileSystem
    );
    return utils.loadCssModule(loaderContext, filename);
  });

const rebuildModule = (compilation, module) =>
  new Promise((resolve, reject) => {
    compilation.rebuildModule(module, err => {
      if (err) reject(err);
      else resolve();
    });
  });

const seal = compilation =>
  new Promise((resolve, reject) => {
    compilation.seal(err => {
      if (err) reject(err);
      else resolve();
    });
  });

const afterCompile = (compiler, compilation) =>
  new Promise((resolve, reject) => {
    compiler.hooks.afterCompile.callAsync(compilation, err => {
      if (err) reject(err);
      else resolve();
    });
  });

module.exports = class PursCssModulesPlugin {
  constructor() {
    this.locals = new Map();
  }

  static pursLoader(options = {}) {
    return {
      loader: path.join(__dirname, "purs-loader"),
      options
    };
  }

  static cssLoader(options = {}) {
    return {
      loader: path.join(__dirname, "css-loader"),
      options: Object.assign({
        modules: true,
        camelCase: "only"
      }, options)
    };
  }

  apply(compiler) {
    const { name } = this.constructor;

    compiler.hooks.thisCompilation.tap(name, (compilation, params) => {
      compilation.hooks.normalModuleLoader.tap(name, (context, module) => {
        context.pursCssModulesLocals = this.locals;
        context.emitWarningOnce = message => {
          const { requestShortener }  = compilation.runtimeTemplate;
          const currentLoader = module.getCurrentLoader(context);
          const from = requestShortener.shorten(currentLoader.loader);
          const warning = [from, message].join("\n");
          if (!compilation.warnings.includes(warning)) {
            compilation.warnings.push(warning);
          }
        };
      });
    });

    compiler.hooks.done.tapPromise(name, catchRebuildErrors(async ({ compilation }) => {
      const missingCssModuleErrors = extractMissingCssModuleErrors(compilation.errors);
      if (!missingCssModuleErrors.length) return;

      await Promise.all(missingCssModuleErrors.map(async err => {
        const { styleSheetPath } = err.cssModule;
        if (await utils.exists(styleSheetPath)) {
          await utils.writeCssModule(Object.assign({
            locals: await loadCssModule(compilation, styleSheetPath),
          }, err.cssModule));
        } else {
          compilation.warnings.push(utils.missingStyleSheetErr({
            fromModuleName: err.moduleName,
            styleSheetPath: path.relative(compiler.context, styleSheetPath)
          }));

          await utils.deleteCssModule(err.cssModule.root);
        }
      }));

      const pursModules = new Set(compilation.errors
        .filter(error => error.module &&
          /\.purs$/.test(error.module.resource))
        .map(error => error.module));

      compilation.errors = compilation.errors.filter(moduleErr =>
        !R.is(pursLoaderUtils.PscError, moduleErr.error) &&
        !pursModules.has(moduleErr.module));

      compilation.unseal();

      await Promise.all(Array.from(pursModules, module => {
        compiler.hooks.invalid.call(module.resource, Date.now());
        return rebuildModule(compilation, module);
      }));

      compilation.finish();

      await seal(compilation);
      await afterCompile(compiler, compilation);
    }));
  }
};
