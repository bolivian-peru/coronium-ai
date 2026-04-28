// PM2 ecosystem config for coronium-api.
//
//   pm2 start apps/api/ecosystem.config.cjs --env production
//   pm2 save
//   pm2 startup    # if not already enabled

module.exports = {
  apps: [
    {
      name: "coronium-api",
      script: "dist/server.js",
      cwd: __dirname,
      instances: 1,                     // single instance — SQLite is the bottleneck
      exec_mode: "fork",
      max_memory_restart: "500M",
      autorestart: true,
      kill_timeout: 10000,              // give graceful shutdown 10s
      listen_timeout: 10000,
      env: {
        NODE_ENV: "production",
        LOG_LEVEL: "info",
      },
    },
  ],
};
