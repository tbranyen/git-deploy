[
  'SECRET',
  'CWD',
  'REMOTE',
  'SOCKET_PRIV',
  'GIT_AUTHOR',
  'GIT_EMAIL'
].forEach(function(ENV) {
  if (!(ENV in process.env)) {
    console.error('Missing environment variable: ' + ENV);
    process.exit();
  }
});

var path = require('path');
var express = require('express');
var Git = require('nodegit');
var exec = require('child_process').execSync;
var createHandler = require('github-webhook-handler');

var GHWebHook = createHandler({ path: '/', secret: process.env.SECRET });
var me = Git.Signature.now(process.env.GIT_AUTHOR, process.env.GIT_EMAIL);
var socketName = process.env.SOCKET_NAME || './socket';

GHWebHook.on('push', function (event) {
  var payload = event.payload;
  var branch = payload.ref.slice('refs/heads/'.length);

  if (branch !== 'development' && branch !== 'production') {
    return;
  }

  function fetchRemote(repo) {
    console.log('Fetching remote', process.env.REMOTE);

    return repo.getRemote(process.env.REMOTE).then(function(remote) {
      var fetchOpts = {
        callbacks: {
          credentials: function(url, userName) {
            return Git.Cred.sshKeyFromAgent(userName);
          }
        }
      };

      return remote.fetch([payload.ref], fetchOpts, 'Fetched latest deployment');
    }).then(function() {
      return repo;
    });
  }

  function changeBranch(repo) {
    return repo.checkoutBranch(branch).then(function() {
      return repo;
    });
  }

  Promise.resolve(process.env.CWD)
    .then(function(path) {
      console.log('Opened repository');
      return Git.Repository.open(path);
    })
    .then(fetchRemote)
    .then(changeBranch)
    .then(function(repo) {
      return repo.getReference(process.env.REMOTE).then(function(ref) {
        console.log('Changing HEAD to', ref.target());

        return repo.setHead(ref.name());
      }).then(function() {
        console.log('Checking out HEAD');

        return Git.Checkout.head(repo, {
          checkoutStrategy: Git.Checkout.STRATEGY.FORCE
        });
      });
    })
    .then(function() {
      console.log('Ensure Node modules are up-to-date');
      exec('npm install --python=python2 && npm update && npm prune', { cwd: process.env.CWD, uid: 1000 });

      console.log('Reloading application');

      try {
        exec('npm run reload', { cwd: process.env.CWD });
      }
      catch (unhandledException) {}

      process.setuid(0);
      console.log('Resetting NGINX');
      exec('nginx -s reload');

      console.log('Completed deployment');
    })
    .catch(function(ex) {
      console.log(ex.stack);
    });
});

var socketPath = socketName;

try { exec('rm ' + socketPath); } catch (ex) {}
express().use(GHWebHook).listen(socketPath);
exec('chown ' + process.env.SOCKET_PRIV + ' ' + socketPath);
