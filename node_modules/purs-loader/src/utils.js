const path = require('path');

exports.PscError = class PscError extends Error {
  constructor(message, modules) {
    super(message);
    this.modules = modules;
  }

  static get name() {
    return 'PscError';
  }
};

const repeat = (value, times) =>
  times <= 0 ? [] : [value, ...repeat(value, times - 1)];
const diffPursModuleNames = (from, target, parts) => {
  if (!from.length) return parts.concat(target);
  if (!target.length) return parts.concat(repeat('..', from.length));
  const [head_from, ...tail_from] = from;
  const [head_target, ...tail_target] = target;
  return head_from === head_target
    ? diffPursModuleNames(tail_from, tail_target, parts)
    : parts.concat(repeat('..', from.length), target);
};
exports.resolvePursModule = ({ baseModulePath, baseModuleName, targetModuleName }) => {
  const parts = diffPursModuleNames(
    baseModuleName.split('.'),
    targetModuleName.split('.'),
    []);
  return parts.length
    ? path.resolve(baseModulePath,
      `${path.join(...parts)}.purs`)
    : baseModulePath;
};
