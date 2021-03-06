import OwnProxy from "../own/proxy.js"

import isOwnProxy from "../util/is-own-proxy.js"
import nativeTrap from "../util/native-trap.js"
import shared from "../shared.js"
import unwrapOwnProxy from "../util/unwrap-own-proxy.js"

function init() {
  const Shim = {
    enable(context) {
      const FuncProto = context.Function.prototype
      const cache = shared.memoize.shimFunctionPrototypeToString

      if (check(FuncProto, cache)) {
        return context
      }

      const _toString = FuncProto.toString
      const { proxyNativeSourceText } = shared

      const NATIVE_SOURCE_TEXT =
        proxyNativeSourceText ||
        "function () { [native code] }"

      // Section 19.2.3.5: Function.prototype.toString()
      // Step 3: Return "function () { [native code] }" for callable objects.
      // https://tc39.github.io/Function-prototype-toString-revision/#proposal-sec-function.prototype.tostring
      const toString = function () {
        let thisArg = this

        if (proxyNativeSourceText &&
            isOwnProxy(thisArg)) {
          thisArg = unwrapOwnProxy(thisArg)
        }

        try {
          return Reflect.apply(_toString, thisArg, [])
        } catch (e) {
          if (typeof thisArg !== "function") {
            throw e
          }
        }

        if (isOwnProxy(thisArg)) {
          try {
            return Reflect.apply(_toString, unwrapOwnProxy(thisArg), [])
          } catch {}
        }

        return NATIVE_SOURCE_TEXT
      }

      try {
        FuncProto.toString = new OwnProxy(_toString, {
          apply: nativeTrap((_toString, thisArg, args) => {
            return Reflect.apply(toString, thisArg, args)
          })
        })

        cache.set(FuncProto, true)
      } catch {}

      return context
    }
  }

  function check(FuncProto, cache) {
    let result = cache.get(FuncProto)

    if (typeof result === "boolean") {
      return result
    }

    result = true

    try {
      const { toString } = FuncProto

      if (typeof toString === "function") {
        const proxy = new OwnProxy(toString, {})

        result = Reflect.apply(toString, proxy, []) === Reflect.apply(toString, toString, [])
      }
    } catch {
      result = false
    }

    cache.set(FuncProto, result)

    return result
  }

  return Shim
}

export default shared.inited
  ? shared.module.shimFunctionPrototypeToString
  : shared.module.shimFunctionPrototypeToString = init()
