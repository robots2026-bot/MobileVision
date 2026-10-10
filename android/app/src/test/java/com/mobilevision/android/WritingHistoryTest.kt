package com.mobilevision.android

import com.mobilevision.android.writing.WritingHistory
import org.junit.Assert.*
import org.junit.Test

class WritingHistoryTest {
    @Test fun clearRestoresAllStrokesAndRetainsEarlierUndo() {
        val items = mutableListOf<String>(); val history = WritingHistory(items)
        history.add("a"); history.add("b"); history.clear()
        assertTrue(items.isEmpty()); assertTrue(history.canUndo)
        history.undo(); assertEquals(listOf("a", "b"), items)
        history.undo(); assertEquals(listOf("a"), items)
        history.redo(); history.redo(); assertTrue(items.isEmpty())
    }
    @Test fun drawingAfterClearUndoesInOrder() {
        val items = mutableListOf<String>(); val history = WritingHistory(items)
        history.add("old"); history.clear(); history.add("new")
        history.undo(); assertTrue(items.isEmpty())
        history.undo(); assertEquals(listOf("old"), items)
        history.redo(); history.redo(); assertEquals(listOf("new"), items)
    }
    @Test fun newStrokeAfterUndoDiscardsRedo() {
        val items = mutableListOf<String>(); val history = WritingHistory(items)
        history.add("old"); history.clear(); history.undo(); history.add("new")
        assertFalse(history.canRedo); assertEquals(listOf("old", "new"), items)
    }
    @Test fun emptyClearDoesNotCreateHistoryOrDiscardRedo() {
        val items = mutableListOf<String>(); val history = WritingHistory(items)
        history.clear(); assertFalse(history.canUndo)
        history.add("a"); history.undo(); history.clear(); assertTrue(history.canRedo)
        history.redo(); assertEquals(listOf("a"), items)
    }
}
