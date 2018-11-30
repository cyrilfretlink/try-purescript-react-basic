const fs = require("fs");
const path = require("path");

const R = require("ramda");
const webpack = require("webpack");

const { PscError } = require("purs-loader/utils");
const { reifyCssModule } = require("./utils");

const findMissingCssModules = R.compose(
  R.filter(R.has("cssModule")),
  moduleErr =>
    moduleErr ? moduleErr.error.modules : [],
  R.find(moduleErr =>
    R.is(PscError, moduleErr.error)));

const catchRebuildErrors = f => stats =>
  f(stats).catch(error => {
    stats.compilation.errors.push(error);
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

const createLoaderContext = (compilation, filename) =>
  createNormalModule(compilation, filename).then(module =>
    module.createLoaderContext(
      compilation.resolverFactory
        .get("normal", module.resolveOptions),
      compilation.options,
      compilation,
      compilation.inputFileSystem
    ));

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
      }, options)
    };
  }

  apply(compiler) {
    const { name } = this.constructor;

    compiler.hooks.thisCompilation.tap(name, (compilation, params) => {
      compilation.hooks.normalModuleLoader.tap(name, (context, module) => {
        context.pursCssModulesLocals = this.locals;
      });
    });

    compiler.hooks.done.tapPromise(name, catchRebuildErrors(async ({ compilation }) => {
      const missingCssModules = findMissingCssModules(compilation.errors);
      if (!missingCssModules.length) return;

      await Promise.all(missingCssModules.map(async desc => {
        const loaderContext = await createLoaderContext(
          compilation, desc.cssModule.styleSheetPath);
        return reifyCssModule(loaderContext, desc, warning => {
          compilation.warnings.push(warning);
        });
      }));

      const pursModules = new Set(compilation.errors
        .filter(error => error.module &&
          /\.purs$/.test(error.module.resource))
        .map(error => error.module));

      compilation.errors = compilation.errors.filter(moduleErr =>
        !R.is(PscError, moduleErr.error) &&
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
