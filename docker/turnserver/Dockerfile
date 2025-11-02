FROM coturn/coturn:4.5

COPY entrypoint.sh /usr/local/bin/turn-entrypoint
RUN chmod +x /usr/local/bin/turn-entrypoint \
    && mkdir -p /etc/turnserver

ENTRYPOINT ["/usr/local/bin/turn-entrypoint"]
CMD []
