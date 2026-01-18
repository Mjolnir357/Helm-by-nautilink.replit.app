# Helm Bridge - Home Assistant Add-on

Connect your Home Assistant instance to the Helm Smart Home Dashboard for unified smart home control.

## About

The Helm Bridge add-on creates a secure connection between your Home Assistant instance and the Helm cloud service. This allows you to:

- View and control all your Home Assistant devices from the Helm dashboard
- Create automations that span multiple smart home platforms
- Monitor device status and get real-time updates
- Access your smart home from anywhere

## Installation

### From the Helm Add-on Repository

1. In Home Assistant, go to **Settings** → **Add-ons** → **Add-on Store**
2. Click the three dots menu (⋮) in the upper right corner
3. Select **Repositories**
4. Add the Helm repository URL: `https://github.com/Mjolnir357/Helm-by-nautilink.replit.app`
5. Click **Add** → **Close**
6. Find "Helm Bridge" in the add-on store and click **Install**

### Manual Installation

1. Download the latest release from GitHub
2. Copy the `helm-bridge` folder to your Home Assistant `addons` directory
3. Go to **Settings** → **Add-ons** and click **Reload**
4. Install "Helm Bridge" from the Local Add-ons section

## Configuration

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `cloud_url` | URL of the Helm cloud server | `https://helm-by-nautilink.replit.app` |
| `log_level` | Logging verbosity (debug/info/warn/error) | `info` |

### Example Configuration

```yaml
cloud_url: "https://helm-by-nautilink.replit.app"
log_level: info
```

## Pairing with Helm

After installing and starting the add-on:

1. Open the Helm web dashboard at [helm-by-nautilink.replit.app](https://helm-by-nautilink.replit.app)
2. Log in or create an account
3. Navigate to **Integrations** → **Home Assistant**
4. Click **Add Bridge**
5. Enter the pairing code shown in the add-on logs
6. Click **Pair** to complete the connection

The bridge will automatically connect and begin syncing your devices.

## Troubleshooting

### Bridge Not Connecting

1. Check the add-on logs for error messages
2. Verify your internet connection
3. Ensure the cloud URL is correct
4. Try restarting the add-on

### Devices Not Appearing

1. Wait a few minutes for the initial sync to complete
2. Check that the bridge is connected (green status in Helm dashboard)
3. Try triggering a manual sync from the Helm dashboard

### Pairing Code Expired

Pairing codes expire after 10 minutes. Restart the add-on to generate a new code.

## Data Privacy

- All communication between the bridge and Helm cloud is encrypted (TLS/WSS)
- Device data is stored securely in your Helm account
- You control which devices are visible in Helm through the import settings
- The bridge only sends data when connected to your verified account

## Support

- [GitHub Issues](https://github.com/Mjolnir357/Helm-by-nautilink.replit.app/issues)

## License

MIT License - See LICENSE file for details.
