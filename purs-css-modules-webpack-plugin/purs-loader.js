const path = require("path");
const fs = require("fs");

const pursLoader = require("purs-loader");
const R = require("ramda");

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

const missingPluginErr = new Error(`
This loader must be used with its corresponding plugin
`.trimLeft());

const missingCSSFileErr = info => new Error(`
Missing ./${info.relCSSModuleFilename} imported by ${info.moduleName}
`.trimLeft());

const unknownCSSModuleLocalsErr = relfilename => new Error(`
Couldn’t extract local class names of ./${relfilename}
`.trimLeft());

const libs = [/bower_components/, /\.psc-package/];

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

module.exports = function (source) {
  if (this.cacheable) this.cacheable();

  if (libs.some(lib => lib.test(this.resourcePath))) {
    return pursLoader.call(this, source);
  }

  const callback = this.async();

  if (!this.pursCSSModulesLocals) {
    return callback(missingPluginErr);
  }

  this.async = () => callback;

  const dependencies = new Set(this.getDependencies());
  const matchModuleName = /\s*module\s+((?:\w+\.)*\w+)\s+where/;
  const [, psModuleName] = matchModuleName.exec(source) || [];

  if (!psModuleName) return pursLoader.call(this, source);

  const matchCSSModuleImport = /^\s*(?<!--)\s*import\s*(((?:\w+\.)*\w+)\.CSS)/mg;
  const imports = [];

  let matchedCSSModuleImport;
  while (matchedCSSModuleImport = matchCSSModuleImport.exec(source)) {
    const [, name, parent] = matchedCSSModuleImport;
    imports.push({ name, parent });
  }

  const uniqueImports = R.uniqBy(R.prop('name'), imports);

  const psModuleDir = path.dirname(this.resourcePath);
  const psModuleBase = path.basename(this.resourcePath, path.extname(this.resourcePath));
  const psCSSModuleDir = path.join(psModuleDir, psModuleBase);

  const promise = Promise.all(uniqueImports.map(({ name: cssModuleName, parent: cssModuleParentName }) => {
    const ownCSSModule = cssModuleParentName === psModuleName;
    const cssModuleFilename = ownCSSModule
      ? path.join(psModuleDir, `${psModuleBase}.css`)
      : resolveFilename({
          base: this.resourcePath,
          from: psModuleName,
          target: cssModuleParentName,
          ext: ".css"
        });

    this.addDependency(cssModuleFilename);
    if (fs.existsSync(cssModuleFilename)) {
      return new Promise((resolve, reject) => {
        this.loadModule(cssModuleFilename, err => {
          if (err) return reject(err);

          const locals = this.pursCSSModulesLocals.get(cssModuleFilename);

          if (!locals) {
            const relCSSModuleFilename = path.relative(this.rootContext, cssModuleFilename);
            return reject(unknownCSSModuleLocalsErr(relCSSModuleFilename));
          }

          if (!fs.existsSync(psCSSModuleDir)) {
            fs.mkdirSync(psCSSModuleDir);
          }
          fs.writeFileSync(path.join(psCSSModuleDir, ".purs-css-module"), "");
          fs.writeFileSync(path.join(psCSSModuleDir, "CSS.js"),
            mkForeignCSSModule(path.relative(psCSSModuleDir, cssModuleFilename)));
          fs.writeFileSync(path.join(psCSSModuleDir, "CSS.purs"),
            mkCSSModule(cssModuleName, Object.keys(locals)));

          resolve(ownCSSModule);
        });
      });
    } else {
      const relCSSModuleFilename = path.relative(this.rootContext, cssModuleFilename);
      this.emitWarning(missingCSSFileErr({
        moduleName: psModuleName,
        relCSSModuleFilename
      }));

      if (fs.existsSync(path.join(psCSSModuleDir, ".purs-css-module"))) {
        for (const filename of [".purs-css-module", "CSS.js", "CSS.purs"]) {
          fs.unlinkSync(path.join(psCSSModuleDir, filename));
        }
        try { fs.rmdirSync(psCSSModuleDir) } catch (notEmptyError) {}
      }

      return ownCSSModule;
    }
  })).then(areOwnCSSModules => {
    if (!areOwnCSSModules.some(Boolean)) {
      if (fs.existsSync(path.join(psCSSModuleDir, ".purs-css-module"))) {
        if (fs.existsSync(path.join(psCSSModuleDir, ".purs-css-module"))) {
          for (const filename of [".purs-css-module", "CSS.js", "CSS.purs"]) {
            fs.unlinkSync(path.join(psCSSModuleDir, filename));
          }
          try { fs.rmdirSync(psCSSModuleDir) } catch (notEmptyError) {}
        }
      }
    }

    const context = Object.preventExtensions(Object.assign(Object.create(this), {
      extractDependencies: error => {
        const matchModuleName = /in module ((?:\w+\.)*\w+)/;
        const [, psModuleName] = matchModuleName.exec(error) || [];

        const matchLocation = /at (.+\.purs) line (\d+), column (\d+) - line (\d+), column (\d+)/;
        const [, filename] = matchLocation.exec(error) || [];

        const matchCSSModuleName = /Module (((?:\w+\.)*\w+)\.CSS) was not found/;
        const [, cssModuleName, cssModuleParentName] = matchCSSModuleName.exec(error) || [];

        if (!psModuleName || !filename || !cssModuleName) return [];

        const psModuleDir = path.dirname(filename);
        const psModuleBase = path.basename(filename, path.extname(filename));
        const ownCSSModule = cssModuleParentName === psModuleName;
        const cssModuleFilename = ownCSSModule
          ? path.join(psModuleDir, `${psModuleBase}.css`)
          : resolveFilename({
              base: filename,
              from: psModuleName,
              target: cssModuleParentName,
              ext: ".css"
            });

        return [path.join(this.rootContext, cssModuleFilename)];
      }
    }));

    pursLoader.call(context, source);
  }, callback);
};
