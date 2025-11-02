FROM coturn/coturn:4.5

COPY --chmod=0755 entrypoint.sh /usr/local/bin/turn-entrypoint

RUN mkdir -p /etc/turnserver

ENTRYPOINT ["/usr/local/bin/turn-entrypoint"]
CMD []
