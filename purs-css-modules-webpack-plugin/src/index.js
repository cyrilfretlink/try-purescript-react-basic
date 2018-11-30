const fs = require("fs");
const path = require("path");

const R = require("ramda");
const webpack = require("webpack");

const pursLoaderUtils = require("purs-loader/utils");
const utils = require("./utils");

const matchCSSModuleName = /Module (((?:\w+\.)*\w+)\.CSS) was not found/;

const catchRebuildErrors = f => stats => {
  return f(stats).catch(error => {
    if (!stats.compilation.errors.includes(error)) {
      stats.compilation.errors.push(error);
    }
  });
};

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

const loadCSSModule = (compilation, filename) =>
  createNormalModule(compilation, filename).then(module => {
    const loaderContext = module.createLoaderContext(
      compilation.resolverFactory
        .get("normal", module.resolveOptions),
      compilation.options,
      compilation,
      compilation.inputFileSystem
    );
    return utils.loadCSSModule(loaderContext, filename);
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

module.exports = class PursCSSModulesPlugin {
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
        context.pursCSSModulesLocals = this.locals;
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

    compiler.hooks.shouldEmit.tap(name, compilation => {
      if (compilation.errors.length > 0) {
        const psMainModuleErr = compilation.errors
          .find(moduleErr => moduleErr.error.psMainModule);
        this.missingCSSModuleErrors = R.compose(
          R.filter(error => !psMainModuleErr ||
            error.moduleName !== psMainModuleErr.error.psMainModule),
          R.uniqWith((a, b) => (
            a.filename === b.filename &&
            a.moduleName === b.moduleName &&
            a.cssModule.name === b.cssModule.name
          )),
          R.map(pscMessage => {
            const [, filename] = pursLoaderUtils.matchErrLocation.exec(pscMessage);
            const psModuleDir = path.dirname(filename);
            const psModuleBase = path.basename(filename, path.extname(filename));
            const [, moduleName] = pursLoaderUtils.matchErrModuleName.exec(pscMessage);
            const [, cssModuleName, cssModuleParentName] = matchCSSModuleName.exec(pscMessage);
            const cssModuleFilename = cssModuleParentName === moduleName
              ? path.join(compiler.context, psModuleDir, `${psModuleBase}.css`)
              : withExtname(".css", pursLoaderUtils.resolvePursModule({
                  baseModulePath: path.join(compiler.context, filename),
                  baseModuleName: moduleName,
                  targetModuleName: cssModuleParentName,
                }));
            const cssModuleDir = path.dirname(cssModuleFilename);
            const cssModuleBase = path.basename(cssModuleFilename, path.extname(cssModuleFilename));
            return {
              filename,
              moduleName,
              cssModule: {
                out: path.join(cssModuleDir, cssModuleBase),
                name: cssModuleName,
                filename: cssModuleFilename,
              }
            }
          }),
          R.filter(R.test(matchCSSModuleName)),
          R.chain(pursLoaderUtils.splitPscErrors),
          R.filter(R.is(String))
        )(compilation.errors);

        return !this.missingCSSModuleErrors.some(err => err.cssModule.exists);
      } else {
        this.missingCSSModuleErrors = [];
      }
    });

    compiler.hooks.done.tapPromise(name, catchRebuildErrors(async ({ compilation }) => {
      const missingCSSModuleErrors = ƒ(compilation.errors); // TODO
      if (!missingCSSModuleErrors.length) return;

      await Promise.all(missingCSSModuleErrors.map(async err => {
        if (await utils.exists(err.cssModule.filename)) {
          await utils.writeCSSModule({
            dest: err.cssModule.out,
            locals: await loadCSSModule(compilation, err.cssModule.filename),
            stylesheetPath: err.cssModule.filename,
            ownerModuleName: err.cssModule.owner // FIXME
          });
        } else {
          compilation.warnings.push(utils.missingStyleSheetErr({
            fromModuleName: err.moduleName,
            styleSheetPath: path.relative(compiler.context, err.cssModule.filename)
          }));

          await utils.deleteCSSModule(err.cssModule.out);
        }
      }));

      const pursModules = new Set(compilation.errors
        .filter(error => error.module &&
          /\.purs$/.test(error.module.resource))
        .map(error => error.module));

      compilation.errors = compilation.errors.filter(err =>
        typeof err === "string" ? !pursLoaderUtils.isPscMessage(err) :
          !pursModules.has(err.module));

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
