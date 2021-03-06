'use strict'

const { finished } = require('stream')
const {
  InvalidArgumentError,
  InvalidReturnValueError
} = require('./core/errors')
const util = require('./core/util')
const { AsyncResource } = require('async_hooks')
const { addSignal, removeSignal } = require('./abort-signal')

class StreamHandler extends AsyncResource {
  constructor (opts, factory, callback) {
    if (!opts || typeof opts !== 'object') {
      throw new InvalidArgumentError('invalid opts')
    }

    const { signal, method, opaque, body } = opts

    try {
      if (typeof callback !== 'function') {
        throw new InvalidArgumentError('invalid callback')
      }

      if (typeof factory !== 'function') {
        throw new InvalidArgumentError('invalid factory')
      }

      if (signal && typeof signal.on !== 'function' && typeof signal.addEventListener !== 'function') {
        throw new InvalidArgumentError('signal must be an EventEmitter or EventTarget')
      }

      if (method === 'CONNECT') {
        throw new InvalidArgumentError('invalid method')
      }

      super('UNDICI_STREAM')
    } catch (err) {
      if (util.isStream(body)) {
        util.destroy(body.on('error', util.nop), err)
      }
      throw err
    }

    this.opaque = opaque || null
    this.factory = factory
    this.callback = callback
    this.res = null
    this.abort = null
    this.trailers = null
    this.body = body

    if (util.isStream(body)) {
      body.on('error', (err) => {
        this.onError(err)
      })
    }

    addSignal(this, signal)
  }

  onConnect (abort) {
    if (!this.callback) {
      abort()
    } else {
      this.abort = abort
    }
  }

  onHeaders (statusCode, headers, resume) {
    const { factory, opaque } = this

    if (statusCode < 200) {
      return
    }

    this.factory = null
    const res = this.runInAsyncScope(factory, null, {
      statusCode,
      headers: util.parseHeaders(headers),
      opaque
    })

    if (
      !res ||
      typeof res.write !== 'function' ||
      typeof res.end !== 'function' ||
      typeof res.on !== 'function'
    ) {
      throw new InvalidReturnValueError('expected Writable')
    }

    res.on('drain', resume)
    // TODO: Avoid finished. It registers an unecessary amount of listeners.
    finished(res, { readable: false }, (err) => {
      const { callback, res, opaque, trailers, abort } = this

      this.res = null
      if (err || !res.readable) {
        util.destroy(res, err)
      }

      this.callback = null
      this.runInAsyncScope(callback, null, err || null, { opaque, trailers })

      if (err) {
        abort()
      }
    })

    this.res = res

    const needDrain = res.writableNeedDrain !== undefined
      ? res.writableNeedDrain
      : res._writableState && res._writableState.needDrain

    return needDrain !== true
  }

  onData (chunk) {
    const { res } = this

    return res.write(chunk)
  }

  onComplete (trailers) {
    const { res } = this

    removeSignal(this)

    this.trailers = trailers ? util.parseHeaders(trailers) : {}

    res.end()
  }

  onError (err) {
    const { res, callback, opaque, body } = this

    removeSignal(this)

    this.factory = null

    if (res) {
      this.res = null
      util.destroy(res, err)
    } else if (callback) {
      this.callback = null
      process.nextTick((self, callback, err, opaque) => {
        self.runInAsyncScope(callback, null, err, { opaque })
      }, this, callback, err, opaque)
    }

    if (body) {
      this.body = null
      util.destroy(body, err)
    }
  }
}

function stream (opts, factory, callback) {
  if (callback === undefined) {
    return new Promise((resolve, reject) => {
      stream.call(this, opts, factory, (err, data) => {
        return err ? reject(err) : resolve(data)
      })
    })
  }

  try {
    this.dispatch(opts, new StreamHandler(opts, factory, callback))
  } catch (err) {
    if (typeof callback === 'function') {
      process.nextTick(callback, err, { opaque: opts && opts.opaque })
    } else {
      throw err
    }
  }
}

module.exports = stream
