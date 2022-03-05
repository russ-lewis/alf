ALF - Automatic Loading Framework

----

ALF is a set of tools for managing a set of Docker containers, for deploying code automatically as changes are made.

ALF has three components:
1) A control plane, which implements a wewbhook for GitHub push notifications and which gives status to the user (as HTML/JSON).  Designed to run inside a Docker container; runs for a long time, without any changes expected.
   * TODO: can we map the host's Docker socket into the control plane container, so that I can run Docker commands inside the container?
2) A container-loader that works with the control plane to implement its container decisions
   * NOTE: If the TODO above works out, then this component might be skipped.
   * Also: a set of scripts to manage same
3) The user containers, which are always going up and down as changes are made in the GitHub repo
   * Doesn't generally run any ALF code; however, it is created and managed by the ALF code in the other two components



