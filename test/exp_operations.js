// *****************************************************************************
// Copyright 2022 Aerospike, Inc.
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

/* eslint-env mocha */
/* global expect */

const Aerospike = require('../lib/aerospike')
const exp = Aerospike.exp
const op = Aerospike.operations

const helper = require('./test_helper')
const keygen = helper.keygen
const tempBin = 'ExpVar'

describe('Aerospike.exp_operations', function () {
  helper.skipUnlessVersion('>= 5.0.0', this)

  const client = helper.client

  async function createRecord (bins, meta = null) {
    const key = keygen.string(helper.namespace, helper.set, { prefix: 'test/exp' })()
    await client.put(key, bins, meta)
    return key
  }

  it('builds up a filter expression value', function () {
    const filter = exp.eq(exp.binInt('intVal'), exp.int(42))
    expect(filter).to.be.an('array')
  })

  describe('read and write exp_operations on arithmetic expressions', function () {
    describe('int bin add expression', function () {
      it('evaluates exp_read op to true if temp bin equals the sum of bin and given value', async function () {
        const key = await createRecord({ intVal: 2 })
        const ops = [
          exp.operations.read(tempBin,
            exp.add(exp.binInt('intVal'), exp.binInt('intVal')),
            0),
          op.read('intVal')
        ]
        const result = await client.operate(key, ops, {})
        // console.log(result)
        expect(result.bins.intVal).to.eql(2)
        expect(result.bins.ExpVar).to.eql(4)
      })
      it('evaluates exp_write op to true if bin equals the sum of bin and given value', async function () {
        const key = await createRecord({ intVal: 2 })
        const ops = [
          exp.operations.write('intVal',
            exp.add(exp.binInt('intVal'), exp.binInt('intVal')),
            0),
          op.read('intVal')
        ]
        const result = await client.operate(key, ops, {})
        // console.log(result)
        expect(result.bins.intVal).to.eql(4)
      })
    })
  })

  describe('read exp_operation on list expressions', function () {
    describe('list bin append expression', function () {
      it('evaluates exp_read op to true if temp bin equals to appended list', async function () {
        const key = await createRecord({ list: [2, 3, 4, 5] })
        const ops = [
          exp.operations.read(tempBin,
            exp.lists.appendItems(exp.binList('list'), exp.binList('list')),
            0),
          op.read('list')
        ]
        const result = await client.operate(key, ops, {})
        // console.log(result)
        expect(result.bins.list).to.eql([2, 3, 4, 5])
        expect(result.bins.ExpVar).to.eql([2, 3, 4, 5, 2, 3, 4, 5])
      })
    })
  })

  describe('write exp_operation on map expressions', function () {
    describe('map bin putItems expression', function () {
      it('evaluates exp_write op to true if temp bin equals to combined maps', async function () {
        const key = await createRecord({ map: { c: 1, b: 2, a: 3 }, map2: { f: 1, e: 2, d: 3 } })
        const ops = [
          exp.operations.write('map',
            exp.maps.putItems(exp.binMap('map'), exp.binMap('map2')),
            0),
          op.read('map')
        ]
        const result = await client.operate(key, ops, {})
        // console.log(result)
        expect(result.bins.map).to.eql({ a: 3, b: 2, c: 1, d: 3, e: 2, f: 1 })
      })
    })
  })

  describe('read exp_operation on bit expressions', function () {
    describe('bit bin get expression', function () {
      it('evaluates exp_read op to true if temp bin equals to bin bits', async function () {
        // const key = await createRecord({ blob: Buffer.from([0b00000001, 0b01000010, 0b01010111, 0b00000100, 0b00000101]) })
        const key = await createRecord({ blob: Buffer.from([0, 1, 2, 3]) })
        const ops = [
          exp.operations.read(tempBin,
            exp.bit.count(exp.binBlob('blob'), exp.uint(32), exp.int(0)), // b0,b1,b10,b11 (4bits set)
            // exp.bit.insert(exp.binBlob('blob'), exp.bytes(Buffer.from([1]), 1), exp.int(1)),
            0),
          op.read('blob')
        ]
        const result = await client.operate(key, ops, {})
        // console.log(result)
        expect(result.bins.ExpVar).to.eql(4)
      })
    })
  })
})
