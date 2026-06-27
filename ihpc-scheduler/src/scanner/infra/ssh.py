"""SSH connection management with paramiko."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import paramiko

if TYPE_CHECKING:
    from ..config import AccountConfig

logger = logging.getLogger(__name__)


class SSHClient:
    """Manages a single SSH connection to a remote host.

    Supports transparent reconnection and proxied (jump-host) connections.
    """

    def __init__(
        self,
        hostname: str,
        account: AccountConfig,
        *,
        ssh_timeout: int = 10,
        command_timeout: int = 15,
    ) -> None:
        self._hostname = hostname
        self._account = account
        self._ssh_timeout = ssh_timeout
        self._command_timeout = command_timeout
        self._client: paramiko.SSHClient | None = None

    @property
    def hostname(self) -> str:
        return self._hostname

    def connect(
        self,
        proxy_transport: paramiko.Transport | None = None,
    ) -> None:
        """Establish an SSH connection, optionally via a proxy transport."""
        self.close()
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

        sock = None
        if proxy_transport is not None:
            sock = proxy_transport.open_channel(
                "direct-tcpip",
                (self._hostname, 22),
                ("127.0.0.1", 0),
            )

        auth_kwargs = self._account.to_auth_kwargs()
        auth_kwargs["timeout"] = self._ssh_timeout

        try:
            client.connect(self._hostname, sock=sock, **auth_kwargs)
            transport = client.get_transport()
            if transport is not None:
                transport.set_keepalive(30)  # prevent idle-drop on long-running commands
            self._client = client
            logger.debug("Connected to %s", self._hostname)
        except Exception:
            client.close()
            raise

    def exec_command(self, command: str, *, read_line: bool = False) -> str:
        """Execute a command and return stdout. Raises on failure.

        Args:
            command: Shell command to run remotely.
            read_line: If True, read only the first output line and return
                immediately without waiting for the channel to close.  Use this
                when the remote command backgrounds a process (nohup … &) and
                you only need the first line of output (e.g. the PID printed by
                ``echo $!``).  Avoids blocking on channel EOF for the lifetime
                of the background job.
        """
        if self._client is None:
            raise RuntimeError(f"Not connected to {self._hostname}")

        _, stdout, stderr = self._client.exec_command(
            command,
            timeout=self._command_timeout,
        )

        if read_line:
            # Don't wait for channel close — just grab the first output line.
            output = stdout.readline().strip()
            if isinstance(output, bytes):
                output = output.decode("utf-8", errors="replace")
            return output

        exit_code = stdout.channel.recv_exit_status()
        output = stdout.read().decode("utf-8", errors="replace").strip()

        if exit_code != 0:
            err = stderr.read().decode("utf-8", errors="replace").strip()
            logger.warning(
                "Command '%s' on %s exited %d: %s",
                command,
                self._hostname,
                exit_code,
                err,
            )

        return output

    @property
    def transport(self) -> paramiko.Transport | None:
        if self._client is None:
            return None
        return self._client.get_transport()

    @property
    def is_connected(self) -> bool:
        if self._client is None:
            return False
        transport = self._client.get_transport()
        return transport is not None and transport.is_active()

    def close(self) -> None:
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None

    def __enter__(self) -> SSHClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


class SSHPool:
    """Manages the SSH connection to the head node and proxied node connections."""

    def __init__(
        self,
        account: AccountConfig,
        *,
        head_node: str = "access.ihpc.uts.edu.au",
        ssh_timeout: int = 10,
        command_timeout: int = 15,
    ) -> None:
        self._account = account
        self._ssh_timeout = ssh_timeout
        self._command_timeout = command_timeout
        self._head = SSHClient(
            head_node,
            account,
            ssh_timeout=ssh_timeout,
            command_timeout=command_timeout,
        )
        self._node_clients: list[SSHClient] = []

    def connect_head(self) -> None:
        self._head.connect()

    @property
    def head(self) -> SSHClient:
        return self._head

    def connect_node(self, hostname: str) -> SSHClient:
        """Open a proxied SSH connection to a compute node via the head node."""
        if not self._head.is_connected:
            self.connect_head()

        client = SSHClient(
            hostname,
            self._account,
            ssh_timeout=self._ssh_timeout,
            command_timeout=self._command_timeout,
        )
        client.connect(proxy_transport=self._head.transport)
        self._node_clients.append(client)
        return client

    def close(self) -> None:
        for client in self._node_clients:
            client.close()
        self._node_clients = []
        self._head.close()

    def __enter__(self) -> SSHPool:
        self.connect_head()
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
