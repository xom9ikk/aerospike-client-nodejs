// *****************************************************************************
// Copyright 2013-2022 Aerospike, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License")
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// *****************************************************************************

'use strict'

/* global context, expect, describe, it */

const Aerospike = require('../lib/aerospike')
const Client = Aerospike.Client
const helper = require('./test_helper')
const keygen = helper.keygen

describe('Client', function () {
  describe('#connect', function () {
    it('return self', function () {
      const client = new Client(helper.config)
      return client.connect()
        .then(client2 => {
          expect(client2).to.equal(client)
          client.close()
        })
    })

    it('should call the callback asynchronously', function (done) {
      const client = new Client(helper.config)
      let async = false
      client.connect(error => {
        if (error) throw error
        expect(async).to.be.true()
        client.close(false)
        done()
      })
      async = true
    })

    it('should return a Promise if callback without callback', function () {
      const client = new Client(helper.config)
      const promise = client.connect()
      expect(promise).to.be.instanceof(Promise)
      return promise.then(() => client.close(false))
    })
  })

  describe('#close', function () {
    it('should be a no-op if close is called after connection error #noserver', function (done) {
      const client = new Client({ hosts: '127.0.0.1:0' })
      client.connect(error => {
        expect(error.message).to.match(/Failed to connect/)
        client.close(false)
        done()
      })
    })

    it('should be possible to call close multiple times', function (done) {
      const client = new Client(helper.config)
      client.connect(error => {
        expect(error).to.be.null()
        client.close(false)
        client.close(false)
        done()
      })
    })

    it('should allow exit when all clients are closed', async function () {
      const test = async function (Aerospike, config) {
        Object.assign(config, { log: { level: Aerospike.log.OFF } })
        const client = await Aerospike.connect(config)
        client.close()

        await new Promise((resolve, reject) => {
          // beforeExit signals that the process would exit
          process.on('beforeExit', resolve)

          setTimeout(() => {
            reject('Process did not exit within 100ms') // eslint-disable-line
          }, 100).unref()
        })
      }

      await helper.runInNewProcess(test, helper.config)
    })
  })

  describe('#isConnected', function () {
    context('without tender health check', function () {
      it('returns false if the client is not connected', function () {
        const client = new Client(helper.config)
        expect(client.isConnected(false)).to.be.false()
      })

      it('returns true if the client is connected', function (done) {
        const client = new Client(helper.config)
        client.connect(function () {
          expect(client.isConnected(false)).to.be.true()
          client.close(false)
          done()
        })
      })

      it('returns false after the connection is closed', function (done) {
        const client = new Client(helper.config)
        client.connect(function () {
          client.close(false)
          expect(client.isConnected(false)).to.be.false()
          done()
        })
      })
    })

    context('with tender health check', function () {
      it("calls the Aerospike C client library's isConnected() method", function (done) {
        const client = new Client(helper.config)
        const orig = client.as_client.isConnected
        client.connect(function () {
          let tenderHealthCheck = false
          client.as_client.isConnected = function () { tenderHealthCheck = true; return false }
          expect(client.isConnected(true)).to.be.false()
          expect(tenderHealthCheck).to.be.true()
          client.as_client.isConnected = orig
          client.close(false)
          done()
        })
      })
    })
  })

  describe('Client#getNodes', function () {
    const client = helper.client

    it('returns a list of cluster nodes', function () {
      const nodes = client.getNodes()

      expect(nodes).to.be.an('array')
      expect(nodes.length).to.be.greaterThan(0)
      nodes.forEach(function (node) {
        expect(node.name).to.match(/^[0-9A-F]{15}$/)
        expect(node.address).to.be.a('string')
      })
    })
  })

  context.skip('cluster name', function () {
    it('should fail to connect to the cluster if the cluster name does not match', function (done) {
      const config = Object.assign({}, helper.config)
      config.clusterName = 'notAValidClusterName'
      const client = new Client(config)
      client.connect(function (err) {
        expect(err.code).to.eq(Aerospike.status.ERR_CLIENT)
        client.close(false)
        done()
      })
    })
  })

  describe('Events', function () {
    it('client should emit nodeAdded events when connecting', function (done) {
      const client = new Client(helper.config)
      client.once('nodeAdded', event => {
        client.close()
        done()
      })
      client.connect()
    })

    it('client should emit events on cluster state changes', function (done) {
      const client = new Client(helper.config)
      client.once('event', event => {
        expect(event.name).to.equal('nodeAdded')
        client.close()
        done()
      })
      client.connect()
    })
  })

  context('callbacks', function () {
    // Execute a client command on a client instance that has been setup to
    // trigger an error; check that the error callback occurs asynchronously,
    // i.e. only after the command function has returned.
    // The get command is used for the test but the same behavior should apply
    // to all client commands.
    function assertErrorCbAsync (client, errorCb, done) {
      const checkpoints = []
      const checkAssertions = function (checkpoint) {
        checkpoints.push(checkpoint)
        if (checkpoints.length !== 2) return
        expect(checkpoints).to.eql(['after', 'callback'])
        if (client.isConnected()) client.close(false)
        done()
      }
      const key = keygen.string(helper.namespace, helper.set)()
      client.get(key, function (err, _record) {
        errorCb(err)
        checkAssertions('callback')
      })
      checkAssertions('after')
    }

    it('callback is asynchronous in case of an client error #noserver', function (done) {
      // trying to send a command to a client that is not connected will trigger a client error
      const client = Aerospike.client()
      const errorCheck = function (err) {
        expect(err).to.be.instanceof(Error)
        expect(err.message).to.equal('Not connected.')
      }
      assertErrorCbAsync(client, errorCheck, done)
    })

    it('callback is asynchronous in case of an I/O error', function (done) {
      // maxConnsPerNode = 0 will trigger an error in the C client when trying to send a command
      const config = Object.assign({ maxConnsPerNode: 0 }, helper.config)
      Aerospike.connect(config, function (err, client) {
        if (err) throw err
        const errorCheck = function (err) {
          expect(err).to.be.instanceof(Error)
          expect(err.code).to.equal(Aerospike.status.ERR_NO_MORE_CONNECTIONS)
        }
        assertErrorCbAsync(client, errorCheck, done)
      })
    })
  })

  describe('#captureStackTraces', function () {
    it('should capture stack traces that show the command being called', function (done) {
      const client = helper.client
      const key = keygen.string(helper.namespace, helper.set)()
      const orig = client.captureStackTraces
      client.captureStackTraces = true
      client.get(key, function (err) {
        expect(err.stack).to.match(/Client.get/)
        client.captureStackTraces = orig
        done()
      })
    })
  })
})
