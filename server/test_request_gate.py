import threading
import time
import unittest

from request_gate import RequestGate


class RequestGateTests(unittest.TestCase):
    def test_waiting_foreground_runs_before_background(self):
        gate = RequestGate(1, 1000, lambda key: key == "foreground")
        gate.acquire("occupied")
        order = []
        def work(key):
            gate.acquire(key, timeout=2)
            order.append(key)
            gate.release()
        background = threading.Thread(target=work, args=("background",))
        foreground = threading.Thread(target=work, args=("foreground",))
        background.start()
        foreground.start()
        with gate.condition:
            self.assertTrue(gate.condition.wait_for(lambda: len(gate.waiting) == 2, timeout=1))
        gate.release()
        background.join(2)
        foreground.join(2)
        self.assertFalse(background.is_alive() or foreground.is_alive())
        self.assertEqual(order, ["foreground", "background"])

    def test_timeout_removes_waiter_without_leaking_permit(self):
        gate = RequestGate(1, 1000, lambda _: False)
        gate.acquire()
        with self.assertRaises(TimeoutError):
            gate.acquire(timeout=0.01)
        self.assertEqual(gate.active, 1)
        self.assertEqual(gate.waiting, {})
        gate.release()

    def test_requests_are_paced_globally(self):
        gate = RequestGate(2, 20, lambda _: False)
        gate.acquire()
        started = time.monotonic()
        gate.acquire()
        self.assertGreaterEqual(time.monotonic() - started, 0.045)
        gate.release()
        gate.release()


if __name__ == "__main__":
    unittest.main()
