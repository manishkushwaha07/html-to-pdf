
const path = require('path');

const root_path = 'C:/htmltopdf';

module.exports = {
  apps : [
    {
      name: 'htmltopdf',
      script: path.join(__dirname, 'server.js'), //    script: './server.js',
      exec_mode  : 'fork', //cluster | fork
      instances: 1, // 'max' or  a specific number like 4 | for 'fork' instances use 1
      watch: false,	// set true to auto-reload when files change
      autorestart: true,
      max_memory_restart: '1G',	// restart if memory exceeds 300MB/1G
      wait_ready: true,     //wait for the 'ready' signal from server before considering it online
      listen_timeout: 5000, //time pm2 waits for the 'ready' message
      kill_timeout: 5000,   //time pm2 waits fro graceful shutdown before force killing
      log_date_format : 'YYYY-MM-DD HH:mm:ss ',
      error_file : `${root_path}/logs/error.log`,
      out_file : `${root_path}/logs/success.log`,
      // Default variables for any environment
      env: {
        DIST_PATH : 'C:/htmltopdf/dist/',
        SSL_CERT_PATH : `${root_path}/ssl/`
      },
      // Override variables for production
      env_production: {
        BACKEND_SERVER : 'http://172.23.0.52:8080',
        SSL_CERT_PATH : `${root_path}/ssl/`
      }
    },
  ],
  
  /*deploy : {
    production : {
      user : 'node',
      host : '212.83.163.1',
      ref  : 'origin/master',
      repo : 'git@github.com:repo.git',
      path : '/var/www/production',
      'post-deploy' : 'npm install && pm2 reload ecosystem.config.js --env production'
    }
  } */
};
