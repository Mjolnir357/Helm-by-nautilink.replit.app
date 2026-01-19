# Changelog

All notable changes to the Helm Bridge add-on will be documented in this file.

## [1.1.0] - 2026-01-19

### Fixed
- Fixed WebSocket URL construction for Home Assistant Supervisor environment
- Resolved 404 errors when accessing Home Assistant registries
- Made type mappers more robust to handle missing fields gracefully
- Fixed `get_services` response format handling (dictionary to array transformation)

### Improved
- Added detailed step-by-step logging during connection sequence
- Entity registry and state loading are now non-fatal (bridge continues if they fail)
- Better error messages for troubleshooting connection issues

### Changed
- Switched from REST API to WebSocket for accessing areas, devices, entities, states, and services registries

## [1.0.0] - 2026-01-18

### Added
- Initial release of Helm Bridge add-on
- WebSocket connection to Home Assistant for real-time updates
- Pairing code generation displayed in add-on logs
- Cloud sync with Helm Smart Home Dashboard
- Support for all major architectures (amd64, aarch64, armhf, armv7, i386)
- Health check endpoint for monitoring
- Automatic reconnection on connection loss
