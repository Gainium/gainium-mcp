module.exports = {
  apps: [
    {
      name: 'Gainium MCP server',
      interpreter: 'bash',
      script: 'npm.sh',
      args: 'start',
      watch: false,
    },
  ],
}
