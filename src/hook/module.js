import ENTRY from "../constant/entry.js"
import ENV from "../constant/env.js"
import ESM from "../constant/esm.js"
import PACKAGE from "../constant/package.js"

import Entry from "../entry.js"
import Loader from "../loader.js"
import Module from "../module.js"
import Package from "../package.js"
import RealModule from "../real/module.js"
import Wrapper from "../wrapper.js"

import compile from "../module/internal/compile.js"
import errors from "../errors.js"
import get from "../util/get.js"
import getLocationFromStackTrace from "../error/get-location-from-stack-trace.js"
import has from "../util/has.js"
import isError from "../util/is-error.js"
import isStackTraceMaskable from "../util/is-stack-trace-maskable.js"
import maskFunction from "../util/mask-function.js"
import maskStackTrace from "../error/mask-stack-trace.js"
import readFile from "../fs/read-file.js"
import relaxRange from "../util/relax-range.js"
import toString from "../util/to-string.js"
import satisfies from "../util/satisfies.js"
import setProperty from "../util/set-property.js"
import setPrototypeOf from "../util/set-prototype-of.js"
import shared from "../shared.js"
import toExternalFunction from "../util/to-external-function.js"

const {
  STATE_EXECUTION_COMPLETED,
  STATE_EXECUTION_STARTED,
  STATE_INITIAL
} = ENTRY

const {
  OPTIONS
} = ENV

const {
  PACKAGE_VERSION
} = ESM

const {
  MODE_ALL,
  MODE_AUTO,
  RANGE_ALL
} = PACKAGE

const {
  ERR_REQUIRE_ESM
} = errors

const exts = [".js", ".json", ".mjs", ".cjs", ".wasm"]
const importExportRegExp = /^.*?\b(?:im|ex)port\b/
const realExtsJS = RealModule._extensions[".js"]

function hook(Mod, parent) {
  const { _extensions } = Mod
  const passthruMap = new Map

  let parentPkg = Package.from(parent)

  if (parentPkg === null) {
    parentPkg = Package.from(parent, OPTIONS || true)
  }

  const defaultPkg = parentPkg.clone()
  const defaultOptions = defaultPkg.options

  defaultPkg.range = RANGE_ALL

  if (! defaultOptions.force &&
      defaultOptions.mode === MODE_ALL) {
    defaultOptions.mode = MODE_AUTO
  }

  Loader.state.package.default = defaultPkg
  Module._extensions = _extensions

  const jsManager = createManager(".js")

  function createManager(ext) {
    return function managerWrapper(manager, func, args) {
      const [, filename] = args
      const pkg = Package.from(filename)
      const wrapped = Wrapper.find(_extensions, ext, relaxRange(pkg.range))

      return wrapped === null
        ? tryPassthru.call(this, func, args, pkg)
        : Reflect.apply(wrapped, this, [manager, func, args])
    }
  }

  function jsWrapper(manager, func, args) {
    const [mod, filename] = args
    const shouldOverwrite = ! Entry.has(mod)
    const entry = Entry.get(mod)
    const ext = entry.extname
    const pkg = entry.package

    const compileFallback = () => {
      entry.state = STATE_EXECUTION_STARTED

      let threw = true

      try {
        tryPassthru.call(this, func, args, pkg)
        threw = false
      } finally {
        entry.state = threw
          ? STATE_INITIAL
          : STATE_EXECUTION_COMPLETED
      }
    }

    if (entry._passthruCompile ||
        (shouldOverwrite &&
         ext === ".mjs")) {
      entry._passthruCompile = false
      compileFallback()
      return
    }

    const { compileData, runtime } = entry

    if (runtime !== null &&
        runtime._runResult !== void 0) {
      compile(manager, entry, null, filename, compileFallback)
      return
    }

    const { _compile } = mod
    const shouldRestore = shouldOverwrite && has(mod, "_compile")

    const compileWrapper = toExternalFunction((content, filename) => {
      if (shouldOverwrite) {
        if (shouldRestore) {
          mod._compile = _compile
        } else {
          Reflect.deleteProperty(mod, "_compile")
        }
      }

      compile(manager, entry, content, filename, compileFallback)
    })

    if (shouldOverwrite) {
      mod._compile = compileWrapper
      setPrototypeOf(mod, Module.prototype)
    } else {
      Reflect.defineProperty(mod, shared.symbol._compile, {
        configurable: true,
        value: compileWrapper
      })
    }

    if (ext === ".json" ||
        ext === ".wasm") {
      compile(manager, entry, null, filename, compileFallback)
      return
    }

    if ((compileData === null ||
         compileData.transforms === 0) &&
        this !== Loader.state.module.extensions &&
        passthruMap.get(func)) {
      tryPassthru.call(this, func, args, pkg)
    } else {
      mod._compile(readFile(filename, "utf8"), filename)
    }
  }

  for (const ext of exts) {
    const extIsMJS = ext === ".mjs"

    if (extIsMJS &&
        ! Reflect.has(_extensions, ext)) {
      _extensions[ext] = maskFunction(mjsCompiler, realExtsJS)
    }

    const extIsWASM = ext === ".wasm"

    if (extIsWASM &&
        ! shared.support.wasm) {
      continue
    }

    if (! Reflect.has(_extensions, ext)) {
      _extensions[ext] = realExtsJS
    }

    const extCompiler = Wrapper.unwrap(_extensions, ext)

    let passthru =
      typeof extCompiler === "function" &&
      ! has(extCompiler, shared.symbol.mjs)

    if (extIsMJS &&
        passthru) {
      try {
        extCompiler()
      } catch (e) {
        if (isError(e) &&
            e.code === "ERR_REQUIRE_ESM") {
          passthru = false
        }
      }
    }

    Wrapper.manage(_extensions, ext, jsManager)
    Wrapper.wrap(_extensions, ext, jsWrapper)

    passthruMap.set(extCompiler, passthru)
    Loader.state.module.extensions[ext] = _extensions[ext]
  }
}

function mjsCompiler(mod, filename) {
  throw new ERR_REQUIRE_ESM(filename)
}

function tryPassthru(func, args, pkg) {
  let error

  try {
    return Reflect.apply(func, this, args)
  } catch (e) {
    error = e
  }

  if (Loader.state.package.default.options.debug ||
      ! isStackTraceMaskable(error)) {
    throw error
  }

  const name = get(error, "name")

  let [, filename] = args

  if (name === "SyntaxError") {
    const message = toString(get(error, "message"))
    const { range } = pkg

    if (importExportRegExp.test(message) &&
        ! satisfies(PACKAGE_VERSION, range)) {
      const newMessage =
        "Expected esm@" + range +
        ". Using esm@" + PACKAGE_VERSION + ": " + filename

      setProperty(error, "message", newMessage)

      const stack = get(error, "stack")

      if (typeof stack === "string") {
        setProperty(error, "stack", stack.replace(message, () => newMessage))
      }
    }

    pkg.cache.dirty = true
  }

  const loc = getLocationFromStackTrace(error)

  if (loc !== null) {
    filename = loc.filename
  }

  maskStackTrace(error, { filename })

  throw error
}

Reflect.defineProperty(mjsCompiler, shared.symbol.mjs, {
  value: true
})

export default hook
