const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const MemoryFs = require('memory-fs');
const R = require('ramda');

const dedent = str => {
  const lines = str.split("\n");
  const start = lines
    .filter(line => line.length > 0)
    .map(line => {
      const [indent = ""] = line.match(/^\s*/) || [];
      return indent.length;
    }).reduce((a, b) => Math.min(a, b));
  return lines.map(line => line.slice(start)).join("\n");
};

const mkForeignCSSModule = relpath => dedent(`
  "use strict";

  exports.importCSSModule = function () {
    return require(\"${relpath}\");
  };
`).trimLeft();

const indent = (n, str) =>
  str.split("\n").map(line => " ".repeat(n) + line).join("\n");

const mkClassNamesRow = classes => {
  if (!classes.length) return " ()";
  return "\n" + indent(4, `( ${classes.map(k => `"${k}" :: String`).join("\n, ")} )`);
};

const mkClassNamesProxies = classes =>
  classes.map(k => `  ${k} = SProxy :: SProxy "${k}"`).join("\n");

const mkCSSModule = (name, classes) => dedent(`
  module ${name} where

  import Prelude
  import Prim.Row as Row
  import Effect (Effect)
  import Record as Record
  import Data.Symbol (class IsSymbol, SProxy${classes.length ? "(..)" : ""})

  type ClassNames =${mkClassNamesRow(classes)}

  foreign import importCSSModule :: Effect (Record ClassNames)

  withCSSModule :: ∀ k rest.
    IsSymbol k =>
    Row.Cons k String rest ClassNames =>
    Effect (SProxy k -> String)
  withCSSModule = flip Record.get <$> importCSSModule

${mkClassNamesProxies(classes)}
`).trimLeft();

const missingCSSFileErr = info => new Error(`
Missing ./${info.relCSSModuleFilename} imported by ${info.moduleName}
`.trimLeft());

const unknownCSSModuleLocalsErr = relfilename => new Error(`
Couldn’t extract local class names of ./${relfilename}
`.trimLeft());

const matchModuleName = /in module ((?:\w+\.)*\w+)/;
const matchLocation = /at (.+\.purs) line (\d+), column (\d+) - line (\d+), column (\d+)/;
const matchCSSModuleName = /Module (((?:\w+\.)*\w+)\.CSS) was not found/;

const matchSingleError = /Error found:/;
const pscErrorsSeparator = /\n(?=Error)/;
const splitPscErrors = pscMessage => {

  debugger;

  return pscMessage.split(pscErrorsSeparator);
};

const repeat = (value, times) => {
  if (times <= 0) return [];
  const repeated = [];
  for (let n = 0; n < times; n += 1) {
    repeated.push(value);
  }
  return value;
};

const diffModuleNames = (from, target, parts) => {
  if (!from.length) return parts.concat(target);
  if (!target.length) return parts.concat(repeat("..", from.length));
  const [head_from, ...tail_from] = from;
  const [head_target, ...tail_target] = target;
  return head_from === head_target
    ? diffModuleNames(tail_from, tail_target, parts)
    : parts.concat(repeat("..", from.length), target);
};

const resolveFilename = ({ base, from, target, ext = ".purs" }) => {
  const parts = diffModuleNames(from.split("."), target.split("."), []);
  return path.resolve(base, path.join(...parts) + ext);
};

const isPscMessage = message =>
  [matchModuleName, matchLocation].every(re => re.test(message));

module.exports = class PursCSSModulesPlugin {
  constructor() {
    this.locals = new Map();
    this.missingCSSModuleErrors = [];
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

      debugger;

      if (compilation.errors.length > 0) {
        const knownResources = new Set(compilation.modules.map(module => module.resource));
        this.missingCSSModuleErrors = R.compose(
          R.filter(error =>
            !knownResources.has(path.join(compiler.context, error.filename))),
          R.uniqWith((a, b) => (
            a.filename === b.filename &&
            a.moduleName === b.moduleName &&
            a.cssModule.name === b.cssModule.name
          )),
          R.map(pscMessage => {
            const [, filename] = matchLocation.exec(pscMessage);
            const psModuleDir = path.dirname(filename);
            const psModuleBase = path.basename(filename, path.extname(filename));
            const [, moduleName] = matchModuleName.exec(pscMessage);
            const [, cssModuleName, cssModuleParentName] = matchCSSModuleName.exec(pscMessage);
            const cssModuleFilename = cssModuleParentName === moduleName
              ? path.join(compiler.context, psModuleDir, `${psModuleBase}.css`)
              : resolveFilename({
                  base: path.join(compiler.context, filename),
                  from: moduleName,
                  target: cssModuleParentName,
                  ext: ".css"
                });
            const cssModuleDir = path.dirname(cssModuleFilename);
            const cssModuleBase = path.basename(cssModuleFilename, path.extname(cssModuleFilename));
            return {
              filename,
              moduleName,
              cssModule: {
                out: path.join(cssModuleDir, cssModuleBase),
                name: cssModuleName,
                filename: cssModuleFilename,
                exists: fs.existsSync(cssModuleFilename)
              }
            }
          }),
          R.filter(R.test(matchCSSModuleName)),
          R.chain(splitPscErrors),
          R.filter(R.is(String))
        )(compilation.errors);

        return !this.missingCSSModuleErrors.some(err => err.cssModule.exists);
      } else {
        this.missingCSSModuleErrors = [];
      }
    });

    const reportErrors = f => stats => {
      return f(stats).catch(error => {
        if (!stats.compilation.errors.includes(error)) {
          stats.compilation.errors.push(error);
        }
      });
    };

    compiler.hooks.done.tapPromise(name, reportErrors(async ({ compilation }) => {

      debugger;

      if (this.missingCSSModuleErrors.length) {

        console.log('> [purs-css-modules-webpack-plugin]', this.missingCSSModuleErrors.map(err => err.moduleName));

        await Promise.all(this.missingCSSModuleErrors.map(err => {
          if (err.cssModule.exists) {
            const entry = webpack.SingleEntryPlugin.createDependency(err.cssModule.filename);
            const factory = compilation.dependencyFactories.get(entry.constructor);
            return new Promise((resolve, reject) => {
              factory.create({ dependencies: [entry] }, (_err0, module) => {
                if (_err0) return reject(_err0);
                const loaderContext = module.createLoaderContext(
                  compilation.resolverFactory.get("normal", module.resolveOptions),
                  compilation.options,
                  compilation,
                  compilation.inputFileSystem
                );
                loaderContext.loadModule(err.cssModule.filename, (_err1, source, map, module) => {
                  if (_err1) return reject(_err1);

                  const dep = module.dependencies.find(dep => dep.module &&
                    dep.module.resource === module.resource);

                  if (dep && dep.module.error) return reject(dep.module.error);

                  try {
                    const locals = loaderContext.pursCSSModulesLocals.get(err.cssModule.filename);

                    if (!locals) {
                      const relCSSModuleFilename = path.relative(loaderContext.rootContext, err.cssModule.filename);
                      return reject(unknownCSSModuleLocalsErr(relCSSModuleFilename));
                    }

                    if (!fs.existsSync(err.cssModule.out)) {
                      fs.mkdirSync(err.cssModule.out);
                    }
                    fs.writeFileSync(path.join(err.cssModule.out, ".purs-css-module"), "");
                    fs.writeFileSync(path.join(err.cssModule.out, "CSS.js"),
                      mkForeignCSSModule(path.relative(err.cssModule.out, err.cssModule.filename)));
                    fs.writeFileSync(path.join(err.cssModule.out, "CSS.purs"),
                      mkCSSModule(err.cssModule.name, Object.keys(locals)));
                    resolve();
                  } catch (_err2) {
                    reject(_err2);
                  }
                });
              });
            });
          } else {
            const relCSSModuleFilename = path.relative(compiler.context, err.cssModule.filename);
            compilation.warnings.push(missingCSSFileErr({
              moduleName: err.moduleName,
              relCSSModuleFilename
            }));

            if (fs.existsSync(path.join(err.cssModule.out, ".purs-css-module"))) {
              for (const filename of [".purs-css-module", "CSS.js", "CSS.purs"]) {
                fs.unlinkSync(path.join(err.cssModule.out, filename));
              }
              try { fs.rmdirSync(err.cssModule.out) } catch (notEmptyError) {}
            }
          }
        }));

        const pursModules = new Set(compilation.errors
          .filter(error => error.module &&
            /\.purs$/.test(error.module.resource))
          .map(error => error.module));

        compilation.errors = compilation.errors.filter(err =>
          typeof err === 'string' ? !isPscMessage(err) :
            !pursModules.has(err.module));

        compilation.unseal();

        await Promise.all(Array.from(pursModules, module => {
          compiler.hooks.invalid.call(module.resource, Date.now());
          return new Promise((resolve, reject) => {
            compilation.rebuildModule(module, err => {
              if (err) reject(err);
              else resolve();
            });
          });
        }));

        compilation.finish();

        await new Promise((resolve, reject) => {
          compilation.seal(err => {
            if (err) reject(err);
            else resolve();
          });
        });

        await new Promise((resolve, reject) => {
          compiler.hooks.afterCompile.callAsync(compilation, err => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
    }));
  }
};
