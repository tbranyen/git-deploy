const chalk = require('chalk');

[
  'SECRET',
  'CWD',
  'REMOTE',
  'NODE_UID',
  'SOCKET_PRIV',
  'GIT_AUTHOR',
  'GIT_EMAIL'
].forEach(function(ENV) {
  if (!(ENV in process.env)) {
    console.error(chalk.red('Missing environment variable: ') + ENV);
    process.exit(1);
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
  var headCommit = payload.head_commit.id;

  // Currently only support two environments.
  if (branch !== 'development' && branch !== 'production') {
    return;
  }

  function openRepository(path) {
    console.log('Opened repository');

    return Git.Repository.open(path);
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

  function checkoutCommit(repo) {
    console.log('Checking out commit %s', headCommit);

    repo.setHeadDetached(headCommit);
    return repo;
  }

  function resetHead(repo) {
    console.log('Resetting HEAD');

    return Git.Checkout.head(repo, {
      checkoutStrategy: Git.Checkout.STRATEGY.FORCE
    });
  }

  function installAndReload() {
    console.log('Ensure Node modules are up-to-date');

    exec('npm install --python=python2 && npm update && npm prune', {
      cwd: process.env.CWD,
      uid: Number(process.env.NODE_UID),
    });

    console.log('Reloading application');

    try {
      // TODO Extract uid into env var
      exec('npm run reload', {
        cwd: process.env.CWD,
        uid: Number(process.env.NODE_UID)
      });
    }
    catch (unhandledException) {}

    console.log('Resetting NGINX');
    exec('nginx -s reload');

    console.log('Completed deployment');
  }

  Promise.resolve(process.env.CWD)
    .then(openRepository)
    .then(fetchRemote)
    .then(checkoutCommit)
    .then(resetHead)
    .then(installAndReload)
    .catch(function(ex) {
      console.log(ex.stack);
    });
});

var socketPath = socketName;

try { exec('rm ' + socketPath); } catch (ex) {}
express().use(GHWebHook).listen(socketPath);
exec('chown ' + process.env.SOCKET_PRIV + ' ' + socketPath);
