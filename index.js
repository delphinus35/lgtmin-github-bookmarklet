'use strict';

var util = require('util')
, fs = require('fs')
, path = require('path')
, koa = require('koa')
, common = require('koa-common')
, router = require('koa-router')
, stylus = require('stylus')
, staticCache = require('koa-static-cache')
, views = require('co-views')
, parse = require('co-body')
, Q = require('q')
, request = Q.denodeify(require('request'))
, port = process.env.PORT || 3000
, app = koa()
, csrf = require('koa-csrf')
, key = process.env.APP_KEY || 'im a secret'
, Client = require('./github-api-client.js')
, client
, UglifyJs = require('uglify-js')
, nib = require('nib')
, jeet = require('jeet')
, browserify = require('./browserify-middleware')
, reactify = require('reactify')
, lgtmMarkdown = function(hash) {
  return '[![LGTM](http://www.lgtm.in/p/' + hash + ')]'
    + '(http://www.lgtm.in/i/' + hash + ')'
    + '\n\n[:+1:](http://www.lgtm.in/u/' + hash + ')'
    + '[:-1:](http://www.lgtm.in/r/' + hash + ')'
}
, TITLE = 'LGTM.in GitHub Bookmarklet'
;

// base setup
app.use(common.logger());
app.keys = [key];
app.use(common.session());
csrf(app);

// views
app.use(function *(next) {
  var _render = views('views', { default: 'jade' });
  this.render = function (view, locals) {
    var body, html
    ;

    if (!locals) locals = {};

    locals.title = TITLE;

    return function *() {
      this.type = 'text/html';
      body = yield _render(view, locals);
      html = yield _render('layout', { title: TITLE, body: body });
      this.body = html;
    }
  }

  yield next;
});

// assets
if (process.env.NODE_ENV != 'production') {
  // browserify dynamically only on development
  app.use(browserify({
    root: __dirname + '/assets/src/browserify'
    , transform: reactify
  }));
  // stylus
  app.use(function *(next) {
    function compile(str, path) {
      return stylus(str)
        .set('filename', path)
        .set('compress', true)
        .use(nib())
        .use(jeet());
    }

    yield Q.denodeify(stylus.middleware({
      src: path.join(__dirname, '/assets/src'),
      dest: path.join(__dirname, '/assets'),
      compile: compile
    }))(this.req, this.res);

    yield next;
  });
}
// static
app.use(staticCache(path.join(__dirname, 'assets'), {
  maxAge: 30 * 24 * 60 * 60
  , buffer: true
  , gzip: true
}));

// routes
app.use(router(app));

client = new Client(app, {
  scope: 'user repo'
});

app.get('/', function *(next) {
  var req = this.request
  , bmltCode = yield Q.denodeify(fs.readFile)(
    __dirname + '/assets/src/bookmarklet.js', 'utf8'
  ).then(function(data) {
    var baseUrl = req.protocol + '://' + req.get('host');
    data = data.replace('{BASE_URL}', baseUrl);
    return 'javascript:(function(window,undefined) {'
      + encodeURIComponent(UglifyJs.minify(data, {fromString: true}).code)
      + '})(window);'
    ;
  })
  ;
  
  yield this.render('index', {
   bmltCode: bmltCode
  });
});

function assertParams(ctx, params, valids) {
  var key, val
  ;
  try {
    if(valids.sort().toString()
       !== Object.keys(params).sort().toString()) {
      ctx.throw(400, 'Bad Request');
    }
  } catch (e) {
    ctx.throw(400, 'Bad Request');
  }
  for(key in params) {
    val = params[key];
    if(val == null || val == '') {
      ctx.throw(400, 'Bad Request');
    }
  }
}

app.get('/out', function* (next) {
  this.session.github_login_user = null;
  client.saveToken(this, null);
  this.redirect('back');
});

app.get('/lgtm', client.requireAuth(function *(next) {
  var NUM_LGTMS = 3
  ;

  // cache
  if (!this.session.github_login_user) {
    this.session.github_login_user
      = yield Q.denodeify(this.github.user.get)({})
      .then(function(ret) { return ret; });
  }

  yield this.render('lgtm', {
    csrf: this.csrf
    , user: this.session.github_login_user
  });
}));

app.post('/lgtm', client.requireAuth(function *(next) {
  var ret
  , lgtm = yield parse(this)
  ;

  this._lgtm = lgtm;

  this.assertCsrf(lgtm);
  delete lgtm._csrf;
  assertParams(this, lgtm, ['text', 'user', 'repo', 'number', 'hash']);

  ret = yield Q.denodeify(this.github.issues.createComment)({
    user: lgtm.user
    , repo: lgtm.repo
    , number: lgtm.number
    , body: lgtm.text + '\n\n' + lgtmMarkdown(lgtm.hash)
  }).then(function(ret) {
    return ret;
  });

  yield this.render('lgtm_create');
}, function *() {
  var lgtm = this._lgtm
  ;

  return '/lgtm?user=' + lgtm.user
    + '&repo=' + lgtm.repo
    + '&number=' + lgtm.number
  ;
}));

app.listen(port);
