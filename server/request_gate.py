"""A globally paced, priority-aware LLM admission gate.

Already-sent requests are never cancelled. Waiting requests follow the current
view, with aging so background work is not starved indefinitely.
"""
import threading
import time


class RequestGate:
    def __init__(self, capacity, qps, is_foreground, aging_seconds=60):
        self.capacity = capacity
        self.interval = 1 / qps
        self.is_foreground = is_foreground
        self.aging_seconds = aging_seconds
        self.condition = threading.Condition()
        self.waiting = {}
        self.sequence = 0
        self.active = 0
        self.next_start = 0.0

    def acquire(self, key=None, timeout=120):
        started = time.monotonic()
        deadline = started + timeout
        with self.condition:
            ticket = self.sequence
            self.sequence += 1
            self.waiting[ticket] = (key, started)
            self.condition.notify_all()
            try:
                while True:
                    now = time.monotonic()
                    if now >= deadline:
                        raise TimeoutError("等待模型调用名额超时，请稍后重试。")

                    def rank(candidate):
                        candidate_key, enqueued = self.waiting[candidate]
                        priority = (-1 if now - enqueued >= self.aging_seconds else
                                    0 if self.is_foreground(candidate_key) else 1)
                        return priority, candidate

                    if (self.active < self.capacity and now >= self.next_start
                            and min(self.waiting, key=rank) == ticket):
                        self.active += 1
                        self.next_start = now + self.interval
                        return
                    self.condition.wait(min(0.1, deadline - now))
            finally:
                del self.waiting[ticket]
                self.condition.notify_all()

    def release(self):
        with self.condition:
            if self.active <= 0:
                raise RuntimeError("LLM permit released without acquisition")
            self.active -= 1
            self.condition.notify_all()
