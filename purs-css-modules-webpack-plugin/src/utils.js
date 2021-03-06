const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const R = require("ramda");

const { version } = require("../package.json");
const banner = [
  `This file was generated by https://github.com/fretlink/purs-css-modules-webpack-plugin/tree/v${version}.`,
  "All modifications will be overwritten on compilation, do **not** edit it."
];

const dedent = R.compose(lines => {
  const start = lines
    .filter(line => line.length > 0)
    .map(line => {
      const [indent = ""] = line.match(/^\s*/) || [];
      return indent.length;
    }).reduce(R.min);
  return lines.map(line => line.slice(start)).join("\n");
}, R.split("\n"));

const mkForeignCssModule = filename =>
  banner.map(R.concat("// ")).join("\n") + dedent(`

  "use strict";

  exports.importCssModule = function () {
    return require(\"${filename}\");
  };
`);

const indent = (n, str) =>
  str.split("\n").map(line => " ".repeat(n) + line).join("\n");

const mkClassNamesRow = (depth, classes) => {
  if (!classes.length) return " ()";
  const row = `( ${classes.map(name => `"${name}" :: String`).join("\n, ")} )`;
  return "\n" + indent(depth + 2, row);
};

const mkCssModule = (name, classes) =>
  banner.map(R.concat("-- | ")).join("\n") + dedent(`

  module ${name} where

  import Effect (Effect)

  type ClassNames =${mkClassNamesRow(2, classes)}

  foreign import importCssModule :: Effect (Record ClassNames)
`);

const access = promisify(fs.access);
const exists = filename =>
  access(filename).then(() => true, () => false);

const unknownCssModuleLocalsErr = filename => new Error(`
Couldn’t extract local class names of ./${filename}
`.trimLeft());

const loadCssModule = (loaderContext, filename) =>
  new Promise((resolve, reject) => {
    loaderContext.loadModule(filename, (err, source, map, module) => {
      if (err) return reject(err);

      const dep = module.dependencies.find(dep => dep.module &&
        dep.module.resource === module.resource);

      if (dep && dep.module.error) return reject(dep.module.error);

      const locals = loaderContext.pursCssModulesLocals.get(filename);
      if (locals) return resolve(locals);

      reject(unknownCssModuleLocalsErr(
        path.relative(loaderContext.rootContext, filename)));
    });
  });

const DOT_PURS_CSS_MODULE = ".purs-css-module";

const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);
const cssModuleConflictErr = ({ root, filename }) => new Error(dedent(`
Couldn’t overwrite ./${filename} because ./${root} isn’t a CSS module root

   Create a file ./${path.join(root, DOT_PURS_CSS_MODULE)} to turn ./${root} into a CSS module root and overwrite ./${filename} or rename ./${filename}
`.trimLeft()));
const writeCssModule = async ({ base, root, locals, styleSheetPath, namespace }) => {
  const dotCssModulePath = path.join(root, DOT_PURS_CSS_MODULE);
  const foreignCssModulePath = path.join(root, "CSS.js");
  const cssModulePath = path.join(root, "CSS.purs");

  if (await exists(root)) {
    if (!(await exists(dotCssModulePath))) {
      for (const filename of [foreignCssModulePath, cssModulePath]) {
        if (exists(filename)) {
          const dependencies = [path.join(root, DOT_PURS_CSS_MODULE), filename];
          throw Object.assign(cssModuleConflictErr({
            filename: path.relative(base, filename),
            root: path.relative(base, root)
          }), { dependencies });
        }
      }
    }
  } else {
    await mkdir(root);
  }

  await Promise.all([
    writeFile(dotCssModulePath, ""),
    writeFile(foreignCssModulePath,
      mkForeignCssModule(path.relative(root, styleSheetPath))),
    writeFile(cssModulePath,
      mkCssModule(`${namespace}.CSS`, Object.keys(locals)))
  ]);
};

const rm = promisify(fs.unlink);
const rmdir = promisify(fs.rmdir);
const deleteCssModule = async root => {
  if (await exists(path.join(root, DOT_PURS_CSS_MODULE))) {
    await Promise.all([".purs-css-module", "CSS.js", "CSS.purs"]
      .map(filename => rm(path.join(root, filename))));
    await rmdir(root).catch(notEmptyErr => {});
  }
};

const missingStyleSheetErr = ({ styleSheetPath, fromModuleName }) => new Error(`
Missing ./${styleSheetPath} imported by ${fromModuleName}
`.trimLeft());

exports.reifyCssModule = async (loaderContext, desc, onWarning) => {
  const { styleSheetPath } = desc.cssModule;
  if (await exists(styleSheetPath)) {
    try {
      await writeCssModule(Object.assign({
        base: loaderContext.rootContext,
        locals: await loadCssModule(
          loaderContext, styleSheetPath)
      }, desc.cssModule));
    } catch (reason) {
      for (const dep of reason.dependencies || []) {
        loaderContext.addDependency(dep);
      }
      throw reason;
    }
  } else {
    onWarning(missingStyleSheetErr({
      fromModuleName: desc.name,
      styleSheetPath: path.relative(
        loaderContext.rootContext, styleSheetPath)
    }));

    await deleteCssModule(desc.cssModule.root);
  }
};

exports.missingPluginErr = new Error(`
This loader must be used with its corresponding plugin
`.trimLeft());
