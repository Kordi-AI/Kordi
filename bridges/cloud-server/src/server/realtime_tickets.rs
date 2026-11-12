//! The process-wide limit on issuing chat realtime tickets.

use super::ServerState;
use crate::chat_sync::realtime::TicketAdmission;

impl ServerState {
    /// The limit every ticket request in this process shares.
    pub(crate) fn realtime_tickets(&self) -> &TicketAdmission {
        &self.realtime_tickets
    }

    /// Replaces the limit read from the environment.
    pub fn with_realtime_ticket_admission(mut self, admission: TicketAdmission) -> Self {
        self.realtime_tickets = admission;
        self
    }
}
