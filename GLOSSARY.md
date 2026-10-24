# Soothe

Soothe connects one console to a serial device or a simulated demo at a time.

## Language

**Serial session**:
A connection to one physical serial device, including the received bytes and connection status belonging to that connection.

**Console session**:
One period of console interaction with either a serial device or the demo. A new connection attempt starts a new console session.

**Received data**:
The bytes received during a console session. Display formatting may add carriage returns, but the received-byte count and session log use the original data.

**Session log**:
The retained received text, including device escape sequences. Clearing the screen does not clear the session log.

**Demo**:
A simulated device session that produces console output and responds to input without opening a physical serial port.
