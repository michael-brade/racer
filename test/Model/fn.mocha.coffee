{expect} = require '../util'
Model = require '../../lib/Model'

describe 'fn', ->

  describe 'fn, removeFn, and run', ->

    it 'supports fn with a getter function', ->
      model = new Model
      model.fn 'sum', (a, b) -> a + b
      model.set '_nums.a', 2
      model.set '_nums.b', 4
      result = model.run 'sum', '_nums.a', '_nums.b'
      expect(result).to.equal 6

    it 'supports fn with an object', ->
      model = new Model
      model.fn 'sum',
        get: (a, b) -> a + b
      model.set '_nums.a', 2
      model.set '_nums.b', 4
      result = model.run 'sum', '_nums.a', '_nums.b'
      expect(result).to.equal 6

    it 'supports fn with variable arguments', ->
      model = new Model
      model.fn 'sum', (args...) ->
        sum = 0
        sum += arg for arg in args
        return sum
      model.set '_nums.a', 2
      model.set '_nums.b', 4
      model.set '_nums.c', 7
      result = model.run 'sum', '_nums.a', '_nums.b', '_nums.c'
      expect(result).to.equal 13

    it 'supports scoped model paths', ->
      model = new Model
      model.fn 'sum', (a, b) -> a + b
      $nums = model.at '_nums'
      $nums.set 'a', 2
      $nums.set 'b', 4
      result = model.run 'sum', '_nums.a', '_nums.b'
      expect(result).to.equal 6
      result = $nums.run 'sum', 'a', 'b'
      expect(result).to.equal 6

    it 'supports removeFn', ->
      model = new Model
      model.fn 'sum', (a, b) -> a + b
      run = -> model.run 'sum', 'x', 'y'
      run()
      model.removeFn 'sum'
      expect(run).to.throwException()

  describe 'start', ->

    it 'sets the output immediately on start', ->
      model = new Model
      model.fn 'sum', (a, b) -> a + b
      model.set '_nums.a', 2
      model.set '_nums.b', 4
      value = model.start 'sum', '_nums.sum', '_nums.a', '_nums.b'
      expect(value).to.equal 6
      expect(model.get '_nums.sum').to.equal 6

    it 'sets the output when an input changes', ->
      model = new Model
      model.fn 'sum', (a, b) -> a + b
      model.set '_nums.a', 2
      model.set '_nums.b', 4
      model.start 'sum', '_nums.sum', '_nums.a', '_nums.b'
      expect(model.get '_nums.sum').to.equal 6
      model.set '_nums.a', 5
      expect(model.get '_nums.sum').to.equal 9

    it 'sets the output when a parent of the input changes', ->
      model = new Model
      model.fn 'sum', (a, b) -> a + b
      model.set '_nums.in', {a: 2,  b: 4}
      model.start 'sum', '_nums.sum', '_nums.in.a', '_nums.in.b'
      expect(model.get '_nums.sum').to.equal 6
      model.set '_nums.in', {a: 5, b: 7}
      expect(model.get '_nums.sum').to.equal 12

    it 'does not set the output when a sibling of the input changes', ->
      model = new Model
      count = 0
      model.fn 'sum', (a, b) -> count++; a + b
      model.set '_nums.in', {a: 2,  b: 4}
      model.start 'sum', '_nums.sum', '_nums.in.a', '_nums.in.b'
      expect(model.get '_nums.sum').to.equal 6
      expect(count).to.equal 1
      model.set '_nums.in.a', 3
      expect(model.get '_nums.sum').to.equal 7
      expect(count).to.equal 2
      model.set '_nums.in.c', -1
      expect(model.get '_nums.sum').to.equal 7
      expect(count).to.equal 2
