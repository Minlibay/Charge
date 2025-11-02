FROM coturn/coturn:4.5

# Ensure we have permissions to prepare the TURN configuration directory and
# copy the entrypoint script while keeping the container running as root so it
# can bind to the privileged TURN ports.
USER root
RUN mkdir -p /etc/turnserver
COPY --chmod=0755 entrypoint.sh /usr/local/bin/turn-entrypoint

ENTRYPOINT ["/usr/local/bin/turn-entrypoint"]
CMD []
