/** Adapted from Strongf's Microsandbox branch: keep the host/LAN outside the
 * guest's trust boundary. No TLS interception or guest credentials are needed:
 * Alive's model/messaging clients remain on the host.
 * DNS is the only host-service exception. Public UDP remains usable for shell
 * workloads; this is destination isolation, not secret-exfiltration prevention.
 */
export function publicNetworkPolicy(sdk: typeof import("microsandbox")) {
	return sdk.NetworkPolicy.builder()
		.defaultDeny()
		.egress((rule) => rule.tcp().udp().port(53).allowHost())
		.egress((rule) => rule.tcp().udp().icmpv4().icmpv6().allowPublic());
}
