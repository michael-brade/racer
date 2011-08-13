rally = require 'rally'
express = require 'express'
fs = require 'fs'

app = express.createServer(
  express.favicon(),
  express.bodyParser(),
  express.cookieParser(),
  express.session secret: 'shhhh_dont_tell'
)
store = rally.store
rally listen: app

# rally.js returns a browserify bundle of the rally client side code and the
# socket.io client side code
script = ''
rally.js (js) -> script = js + fs.readFileSync 'client.js'
style = fs.readFileSync 'style.css'

app.get '/script.js', (req, res) ->
  res.send script, 'Content-Type': 'application/javascript'

app.get '/', (req, res) ->
  res.redirect '/rally'

app.get '/:group', (req, res) ->
  group = req.params.group
  store.subscribe _group: "groups.#{group}.**", (err, model) ->
    initGroup model
    # refs must be explicitly declared per model; otherwise ref is not added
    # to reference indices, $keys and $refs
    model.set '_group.todoList', model.arrayRef '_group.todos', '_group.todoIds'
    model.bundle (bundle) ->
      res.send """
      <!DOCTYPE html>
      <title>Todo list</title>
      <style>#{style}</style>
      <body>
      <form id=head action=javascript:addTodo()>
        <h1>Todos</h1>
        <div id=add><div id=add-input><input id=new-todo></div><input id=add-button type=submit value=Add></div>
      </form>
      <div id=dragbox></div>
      <div id=content><ul id=todos></ul></div>
      <script src=https://ajax.googleapis.com/ajax/libs/jquery/1.6.2/jquery.min.js></script>
      <script src=https://ajax.googleapis.com/ajax/libs/jqueryui/1.8.15/jquery-ui.min.js></script>
      <script src=/script.js></script>
      <script>rally.init(#{bundle})</script>
      """

initGroup = (model) ->
  return if model.get '_group'
  model.set '_group.todos',
    0: {id: 0, completed: true, text: 'This one is done already'}
    1: {id: 1, completed: false, text: 'Example todo'}
    2: {id: 2, completed: false, text: 'Another example'}
  model.set '_group.todoIds', [1, 2, 0]
  model.set '_group.nextId', 3

# Clear any existing data, then initialize
store.flush (err) ->
  throw err if err
  app.listen 3000
  console.log "Go to http://localhost:3000/rally"
